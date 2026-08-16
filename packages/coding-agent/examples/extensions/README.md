# Extension Examples

Example extensions for pi-coding-agent.

## Usage

```bash
# Load an extension with --extension flag
pi --extension examples/extensions/sandbox

# Or copy to extensions directory for auto-discovery
cp -r sandbox ~/.pi/agent/extensions/
```

## Examples

### Lifecycle & Safety

| Extension | Description |
|-----------|-------------|
| `sandbox/` | OS-level sandboxing using `@anthropic-ai/sandbox-runtime` with per-project config |
| `gondolin/` | Route built-in tools and `!` commands into a Gondolin micro-VM |

### Custom Tools

| Extension | Description |
|-----------|-------------|
| `subagent/` | Delegate tasks to specialized subagents with isolated context windows |

### Commands & UI

| Extension | Description |
|-----------|-------------|
| `plan-mode/` | Claude Code-style plan mode for read-only exploration with `/plan` command and step tracking |

### Resources

| Extension | Description |
|-----------|-------------|
| `dynamic-resources/` | Loads skills, prompts, and themes using `resources_discover` |

### Custom Providers

| Extension | Description |
|-----------|-------------|
| `custom-provider-anthropic/` | Custom Anthropic provider with OAuth support and custom streaming implementation |
| `custom-provider-gitlab-duo/` | GitLab Duo provider using pi-ai's built-in Anthropic/OpenAI streaming via proxy |

### External Dependencies

| Extension | Description |
|-----------|-------------|
| `with-deps/` | Extension with its own package.json and dependencies (demonstrates jiti module resolution) |

## Writing Extensions

See [docs/extensions.md](../../docs/extensions.md) for full documentation.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // Subscribe to lifecycle events
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register custom tools
  pi.registerTool({
    name: "greet",
    label: "Greeting",
    description: "Generate a greeting",
    parameters: Type.Object({
      name: Type.String({ description: "Name" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}` }],
        details: {},
      };
    },
  });

  // Register commands
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify("Hello!", "info");
    },
  });
}
```

## Key Patterns

**Use StringEnum for string parameters** (required for Google API compatibility):
```typescript
import { StringEnum } from "@earendil-works/pi-ai";

// Good
action: StringEnum(["list", "add"] as const)

// Bad - doesn't work with Google
action: Type.Union([Type.Literal("list"), Type.Literal("add")])
```

**State persistence via details:**
```typescript
// Store state in tool result details for proper forking support
return {
  content: [{ type: "text", text: "Done" }],
  details: { todos: [...todos], nextId },  // Persisted in session
};

// Reconstruct on session events
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.toolName === "my_tool") {
      const details = entry.message.details;
      // Reconstruct state from details
    }
  }
});
```
