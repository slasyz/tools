import { Rpc } from "@opencode/plugin/rpc";

const string = { type: "string" } as const;
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
const errors = { denied: object({ reason: string }) };

export const SandboxRpc = Rpc.define({
  id: "opencode-sandbox",
  methods: {
    status: { input: object({ sessionID: string }), output: {}, errors },
    poll: { input: object({ sessionID: string, clientID: string }), output: {}, errors },
    claim: { input: object({ id: string, clientID: string }), output: { type: "boolean" }, errors },
    reply: {
      input: object({
        id: string,
        clientID: string,
        action: { enum: ["abort", "session", "global"] },
        value: string,
        confirmed: { type: "boolean" },
      }),
      output: { type: "null" },
      errors,
    },
    control: {
      input: object({ sessionID: string, command: string, arguments: string }),
      output: {},
      errors,
    },
  },
  events: {},
});
