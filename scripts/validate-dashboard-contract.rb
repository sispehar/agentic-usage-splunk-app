#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "pathname"
require "rexml/document"

repo_root = Pathname(__dir__).parent
contract_path = Pathname(
  ARGV[0] || ENV["AGENTIC_ATTRIBUTE_REFERENCE"] ||
    repo_root.join("..", "ai-harness-otel", "ATTRIBUTE_REFERENCE.md")
).expand_path

abort "Attribute reference not found: #{contract_path}" unless contract_path.file?

contract = contract_path.read
dashboard_paths = repo_root.glob(
  "agentic_usage/default/data/ui/views/*.xml"
).sort

errors = []
queries = []

dashboard_paths.each do |path|
  begin
    xml = REXML::Document.new(path.read)
    definition_node = xml.root.elements["definition"]
    raise "missing <definition>" unless definition_node

    definition = JSON.parse(definition_node.text)
  rescue StandardError => e
    errors << "#{path.relative_path_from(repo_root)}: invalid dashboard XML/JSON: #{e.message}"
    next
  end

  definition.fetch("dataSources", {}).each do |name, source|
    query = source.dig("options", "query")
    queries << [path.relative_path_from(repo_root).to_s, name, query] if query
  end
end

contract_namespaces = %w[agentic gen_ai service user session error http exception event]
contract_token_pattern = /\b(?:#{contract_namespaces.join("|")})\.[a-zA-Z0-9_.]+/

queries.each do |path, name, query|
  query.scan(contract_token_pattern).uniq.each do |token|
    next if contract.include?("`#{token}`") || contract.include?("#{token} =")

    errors << "#{path} #{name}: #{token.inspect} is not cataloged in #{contract_path}"
  end

  if query.include?("mstats") && query.include?("agentic.token.usage") &&
     !query.include?("agentic.token.relationship")
    errors << "#{path} #{name}: agentic.token.usage must be gated by agentic.token.relationship"
  end

  if query.match?(/mstats\b.*?\bcount\s+WHERE\b/)
    errors << "#{path} #{name}: use explicit count(_value) with metric_name filtering"
  end

  if query.include?("mstats") && query.include?('"user.email"') && query.include?('"user.id"')
    unless query.include?('mstats fillnull_value="__missing__"')
      errors << "#{path} #{name}: mstats must preserve optional user identity dimensions with fillnull_value"
    end
    unless query.include?("'user.email'!=\"__missing__\"") &&
           query.include?("'user.id'!=\"__missing__\"")
      errors << "#{path} #{name}: mstats identity fallback must discard the fillnull sentinel"
    end
  end

  if query.match?(/\[\s*\|\s*mstats\b/)
    errors << "#{path} #{name}: mstats does not support Splunk subsearches"
  end
end

forbidden_patterns = {
  /metric_name=\\?"gen_ai\.client\.token\.usage\\?"/ =>
    "canonical Histogram is not the cross-harness accounting metric",
  /metric_name=\\?"agentic\.cost\.usage\\?"/ => "obsolete cost metric",
  /metric_name=\\?"agentic\.lines_of_code\.count\\?"/ => "obsolete line metric",
  /metric_name=\\?"agentic\.session\.count\\?"/ => "obsolete session metric",
  /\bterminal\.type\b/ => "producer pass-through field",
  /(?<![.\w])query_source(?![.\w])/ => "pre-normalization source field",
  /(?<![.\w])status_code(?![.\w])/ => "pre-normalization source field",
  /(?<![.\w])error_type(?![.\w])/ => "pre-normalization source field",
  /(?<![.\w])duration_ms(?![.\w])/ => "pre-normalization source field",
  /(?<![.\w])total_tool_uses(?![.\w])/ => "producer pass-through field",
  /(?<![.\w])from_mode(?![.\w])/ => "producer pass-through field",
  /(?<![.\w])to_mode(?![.\w])/ => "producer pass-through field",
  /(?<![.\w])trigger(?![.\w])/ => "producer pass-through field",
  /\b(?:claude_code|gemini_cli|codex)\.[a-zA-Z0-9_.]+/ => "source-native name"
}.freeze

queries.each do |path, name, query|
  forbidden_patterns.each do |pattern, reason|
    match = query.match(pattern)
    errors << "#{path} #{name}: #{reason}: #{match[0]}" if match
  end

  query.scan(/event\.name\s*(?:==|=)\s*\\?"([^"\\]+)\\?"/).flatten.each do |event_name|
    next if event_name.start_with?("agentic.", "gen_ai.")

    errors << "#{path} #{name}: event name is not normalized: #{event_name}"
  end
end

if errors.empty?
  puts "Dashboard contract validation passed (#{queries.length} searches, #{dashboard_paths.length} dashboards)."
  exit 0
end

warn errors.join("\n")
exit 1
