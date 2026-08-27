# Upstream issue draft

Target: [microsoft/vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat/issues)

> Code excerpts below are de-minified from the shipped bundle
> (`Visual Studio Code.app/Contents/Resources/app/extensions/copilot/dist/extension.js`),
> so identifier names are reconstructed. Line references are not available; the
> attribute constants and call shapes are verbatim.

---

**Title:** `maxAttributeSizeChars` is not applied at three OTel call sites, so prompt content and tool schemas are stored unbounded

### Environment

| | |
| --- | --- |
| VS Code | 1.134.0 |
| `github.copilot-chat` | 0.62.0 |
| `agent-traces.db` `schema_version` | 1 |
| OS | macOS 15 (darwin 25.3.0) |

Settings — note that neither content capture nor OTLP export is enabled:

```jsonc
{
  "github.copilot.chat.otel.dbSpanExporter.enabled": true,
  "github.copilot.chat.otel.maxAttributeSizeChars": 1
}
```

`github.copilot.chat.otel.captureContent` is left at its default of `false`, and
the startup log confirms it:

```
[OTel] Instrumentation enabled — exporter=otlp-http endpoint=http://localhost:4318/ captureContent=false
```

### Summary

Three OTel writers call the attribute truncation helper without passing
`maxAttributeSizeChars`. The parameter defaults to `0`, and `0` means
*unlimited*, so those attributes are written in full regardless of the setting:

```js
function truncate(value, max = 0) {
  if (max <= 0 || value.length <= max) return value;   // 0 => unlimited
  const suffix = `...[truncated, original ${value.length} chars]`;
  return max <= suffix.length
    ? value.substring(0, max)
    : value.substring(0, max - suffix.length) + suffix;
}
```

The affected call sites, all on the agent-loop path:

```js
// 1. assistant response text
span.setAttribute(GEN_AI_OUTPUT_MESSAGES,
  truncate(JSON.stringify([{ role: "assistant", parts: [{ type: "text", content }] }])));

// 2. tool schemas on the agent span
span.setAttribute(GEN_AI_TOOL_DEFINITIONS, truncate(toolJson));

// 3. tool schemas again, as a span event
agentSpan.addEvent("tools_available", { toolDefinitions: truncate(toolJson) });
```

Every other content writer passes the limit correctly, e.g.:

```js
span.setAttribute(GEN_AI_INPUT_MESSAGES,
  truncate(JSON.stringify(messages), this._otelService.config.maxAttributeSizeChars));
```

### Steps to reproduce

1. Set the two settings above in **user** settings.
2. Restart VS Code (a window reload is not enough — the setting is read at
   extension-host startup).
3. Run one agent-mode chat turn that invokes at least one tool.
4. Inspect the database:

```sql
SELECT key, COUNT(*), MAX(LENGTH(value))
FROM span_attributes GROUP BY key ORDER BY MAX(LENGTH(value)) DESC;

SELECT name, MAX(LENGTH(attributes)) FROM span_events GROUP BY name;
```

### Expected

Every string attribute truncated to 1 character.

### Actual

Most are. These three are not:

| Attribute | Max length | Content |
| --- | --- | --- |
| `gen_ai.output.messages` | 106 B | assistant response text |
| `gen_ai.tool.definitions` | 99,586 B | built-in tool schemas |
| `tools_available` event | 103,758 B | the same schemas again |

For comparison, correctly truncated in the same database:
`gen_ai.input.messages`, `gen_ai.system_instructions`,
`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`,
`copilot_chat.user_request` — all 1 B.

### Impact

Two distinct problems, worth separating:

**Disk growth.** The tool schemas are not user data, but at ~200 KB per agent
turn they dominate the file. A synthetic 400-turn workload produced a **59.6 MB**
database; deleting only these three payloads reduced it to **0.56 MB**. There is
no retention policy applied to `agent-traces.db`, so this grows without bound.

**Retained content.** `gen_ai.output.messages` is model output, which can
contain source code. An operator who has explicitly set
`maxAttributeSizeChars: 1` — and left `captureContent: false` — reasonably
expects no response text on disk.

### Suggested fix

Pass `this._otelService.config.maxAttributeSizeChars` at the three call sites,
as the surrounding code already does.

Separately, `tools_available` duplicates `gen_ai.tool.definitions` on the same
agent span. If both are intended, deduplicating would remove roughly half the
volume on its own.

### Related: documentation does not match behaviour

[Monitor agent usage with OpenTelemetry](https://code.visualstudio.com/docs/agents/guides/monitoring-agents)
states:

> "When OTel export is enabled, the `github.copilot.chat.otel.captureContent`
> setting controls content capture for both the debug panel and OTLP export."

`captureContent` does gate the BYOK provider paths (Anthropic, Gemini), but the
first-party chat path writes `copilot_chat.user_request`,
`gen_ai.input.messages` and `gen_ai.system_instructions` with no `captureContent`
check — they are bounded only by `maxAttributeSizeChars`. Before setting that to
`1`, a single trivial "hello" turn wrote ~59 KB of content across 6 spans,
including 1,162 bytes of verbatim system prompt, with `captureContent=false`.

Either the gate should cover that path, or the documentation should say that
`maxAttributeSizeChars` is the operative control for local database export.
