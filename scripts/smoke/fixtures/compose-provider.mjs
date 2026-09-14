import { createServer } from "node:http";

const observations = { tools: [], results: [], requests: 0 };
createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/observations") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(observations));
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    observations.requests++;
    observations.tools.push(...(body.tools ?? []).map(tool => tool.function.name));
    const results = body.messages.filter(message => message.role === "tool");
    observations.results.push(...results);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    if (body.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("fixture-hold"))) {
      emit({ role: "assistant", content: "Working" });
      return;
    }
    if (!results.length) {
      emit({ role: "assistant", tool_calls: [{ index: 0, id: "call_context", type: "function",
        function: { name: "director_get_conversation_context", arguments: "{}" } }] });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: "Context verified" });
      emit({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch { res.writeHead(500).end(); }
}).listen(8080, "0.0.0.0");
