import type { AgentEvent, Message, ToolCall } from "../types.js";

export function eventsToMessages(events: AgentEvent[]): Message[] {
  const messages: Message[] = [];
  let openAssistant: Message | undefined;

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        messages.push({ role: "user", content: event.text });
        openAssistant = undefined;
        break;
      case "text":
        if (openAssistant && openAssistant.content !== "" && !openAssistant.toolCalls) {
          messages[messages.length - 1] = {
            role: "assistant",
            content: openAssistant.content + event.text,
          };
          openAssistant = messages[messages.length - 1];
        } else {
          openAssistant = { role: "assistant", content: event.text };
          messages.push(openAssistant);
        }
        break;
      case "tool_call": {
        const call: ToolCall = { id: event.id, name: event.name, args: event.args };
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant" && !last.content) {
          last.toolCalls = [...(last.toolCalls ?? []), call];
        } else {
          openAssistant = { role: "assistant", content: "", toolCalls: [call] };
          messages.push(openAssistant);
        }
        openAssistant = undefined;
        break;
      }
      case "tool_result":
        messages.push({
          role: "tool",
          toolCallId: event.id,
          name: event.name,
          content: event.output,
        });
        openAssistant = undefined;
        break;
      default:
        break;
    }
  }

  return messages;
}
