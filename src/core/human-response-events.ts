import { EventEmitter } from "events";

export interface HumanResponse {
  action: "approved" | "edited" | "feedback";
  feedback?: string;
  taskId?: string;
}

class HumanResponseEmitter extends EventEmitter {
  private static instance: HumanResponseEmitter | null = null;

  static getInstance(): HumanResponseEmitter {
    if (!HumanResponseEmitter.instance) {
      HumanResponseEmitter.instance = new HumanResponseEmitter();
    }
    return HumanResponseEmitter.instance;
  }

  emitResponse(response: HumanResponse): void {
    this.emit("response", response);
  }

  onResponse(handler: (response: HumanResponse) => void): () => void {
    this.on("response", handler);
    return () => {
      this.off("response", handler);
    };
  }
}

export const humanResponseEmitter = HumanResponseEmitter.getInstance();
