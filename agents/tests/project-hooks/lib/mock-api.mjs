// Scripted stand-in for the Anthropic Messages API, for sandboxed session tests.
// No model is involved: it replays the tool calls a test asks for and logs every
// request, so the real Claude Code hook engine can be observed offline.
import http from "node:http";
import fs from "node:fs";

const { MOCK_PORT, MOCK_SCRIPT, MOCK_LOG, MOCK_READY } = process.env;
const script = JSON.parse(fs.readFileSync(MOCK_SCRIPT, "utf8"));
const log = (entry) => fs.appendFileSync(MOCK_LOG, JSON.stringify(entry) + "\n");
const sse = (res, type, data) =>
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

function nextStep(body) {
  const messages = body.messages ?? [];
  const tools = (body.tools ?? []).map((tool) => tool.name);
  if (tools.length === 0) return { text: "ok" };
  const first = JSON.stringify(messages[0]?.content ?? "");
  const steps = first.includes("SUBAGENT-MARKER") ? (script.substeps ?? []) : script.steps;
  const done = messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === "tool_result").length;
  const step = steps[done];
  if (!step) return { text: "DONE" };
  const tool = step.tool === "Agent" && !tools.includes("Agent") ? "Task" : step.tool;
  return { tool, input: step.input };
}

let sequence = 0;

function reply(res, body, step) {
  const id = `msg_${++sequence}`;
  const usage = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const block = step.tool
    ? { type: "tool_use", id: `toolu_${sequence}`, name: step.tool, input: step.input }
    : { type: "text", text: step.text };
  const stop_reason = step.tool ? "tool_use" : "end_turn";
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: [block], stop_reason, stop_sequence: null, usage }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sse(res, "message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
  if (step.tool) {
    sse(res, "content_block_start", { index: 0, content_block: { type: "tool_use", id: block.id, name: step.tool, input: {} } });
    sse(res, "content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input) } });
  } else {
    sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: step.text } });
  }
  sse(res, "content_block_stop", { index: 0 });
  sse(res, "message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
  sse(res, "message_stop", {});
  res.end();
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"input_tokens":10}');
        return;
      }
      if (!req.url.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const body = JSON.parse(raw);
      const step = nextStep(body);
      log({ step, messages: body.messages });
      reply(res, body, step);
    });
  })
  .listen(Number(MOCK_PORT), "127.0.0.1", () => fs.writeFileSync(MOCK_READY, "up"));
