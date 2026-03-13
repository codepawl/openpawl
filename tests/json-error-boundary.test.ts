import { describe, it, expect, vi } from "vitest";

describe("JSON Error Boundaries", () => {
  describe("parseJSON safely", () => {
    const safeJsonParse = (str: string): { success: true; data: unknown } | { success: false; error: Error } => {
      try {
        return { success: true as const, data: JSON.parse(str) };
      } catch (e) {
        return { success: false as const, error: e as Error };
      }
    };

    it("handles valid JSON", () => {
      const result = safeJsonParse('{"key": "value", "num": 42}');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ key: "value", num: 42 });
      }
    });

    it("handles invalid JSON gracefully", () => {
      const invalidJson = "{ this is not valid json";
      const result = safeJsonParse(invalidJson);
      
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(SyntaxError);
      }
    });

    it("handles empty string", () => {
      const result = safeJsonParse("");
      expect(result.success).toBe(false);
    });

    it("handles null input", () => {
      const result = safeJsonParse("null");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it("handles array JSON", () => {
      const result = safeJsonParse('[1, 2, 3, "test"]');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([1, 2, 3, "test"]);
      }
    });

    it("handles deeply nested JSON", () => {
      const nested = JSON.stringify({ a: { b: { c: { d: { e: "deep" } } } } });
      const result = safeJsonParse(nested);
      expect(result.success).toBe(true);
    });
  });

  describe("WebSocket message validation", () => {
    it("validates terminal_out message format", () => {
      const validMessage = { type: "terminal_out", payload: { data: "test output" } };
      const isValid = 
        typeof validMessage === "object" &&
        validMessage.type === "terminal_out" &&
        typeof validMessage.payload === "object" &&
        typeof validMessage.payload.data === "string";
      
      expect(isValid).toBe(true);
    });

    it("rejects missing payload fields", () => {
      const incompleteMessage = { type: "terminal_out" };
      const isValid = 
        typeof incompleteMessage === "object" &&
        incompleteMessage.type === "terminal_out" &&
        typeof (incompleteMessage as any).payload?.data === "string";
      
      expect(isValid).toBe(false);
    });

    it("rejects invalid message types", () => {
      const invalidMessage = { type: "invalid_type", payload: { data: "test" } };
      const validTypes = ["terminal_out", "session_update", "approval_request", "task_update"];
      const isValid = validTypes.includes(invalidMessage.type);
      
      expect(isValid).toBe(false);
    });

    it("handles malformed JSON from WebSocket", () => {
      const malformedData = "not json at all";
      
      let parsed = null;
      let error = null;
      
      try {
        parsed = JSON.parse(malformedData);
      } catch (e) {
        error = e;
      }
      
      expect(parsed).toBeNull();
      expect(error).toBeInstanceOf(SyntaxError);
    });

    it("handles missing fields with defaults", () => {
      const message = { type: "terminal_out" };
      
      const data = (message as any).payload?.data ?? "";
      const messageType = message.type ?? "unknown";
      
      expect(data).toBe("");
      expect(messageType).toBe("terminal_out");
    });
  });

  describe("error recovery", () => {
    it("recovers from partial JSON", () => {
      const partial = '{"key": "value"';
      const recovered = partial + "}";
      
      expect(() => JSON.parse(recovered)).not.toThrow();
    });

    it("provides meaningful error messages", () => {
      const invalidJson = '{"key": "value",}';
      
      let errorMessage = "";
      try {
        JSON.parse(invalidJson);
      } catch (e) {
        errorMessage = (e as Error).message;
      }
      
      expect(errorMessage).toContain("JSON");
    });
  });

  describe("type coercion", () => {
    it("handles number strings", () => {
      const result = JSON.parse("42");
      expect(result).toBe(42);
    });

    it("handles boolean strings", () => {
      const result = JSON.parse("true");
      expect(result).toBe(true);
    });

    it("handles quoted strings", () => {
      const result = JSON.parse('"hello world"');
      expect(result).toBe("hello world");
    });
  });
});
