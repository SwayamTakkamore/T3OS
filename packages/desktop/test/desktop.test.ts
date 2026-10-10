import { describe, expect, it } from "vitest";
import { DesktopClient } from "../src/api.js";
import { mountDesktop } from "../src/main.js";

function fakeClient(): DesktopClient {
  return {
    async listSessions() {
      return [];
    },
    async createSession() {
      return {
        id: "s1",
        title: "t",
        createdAt: "now",
        updatedAt: "now",
        eventCount: 0,
      };
    },
    async getSession() {
      return { id: "s1", events: [] };
    },
    subscribe() {
      return () => {};
    },
  } as unknown as DesktopClient;
}

describe("mountDesktop", () => {
  it("renders a mount point", () => {
    const root = { innerHTML: "", querySelector: () => null } as unknown as HTMLElement;
    const unmount = mountDesktop({ client: fakeClient(), root });
    expect(root.innerHTML).toContain("t3os");
    unmount();
  });
});
