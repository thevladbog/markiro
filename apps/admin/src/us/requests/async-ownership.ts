export function createRequestFence() {
  let generation = 0;
  let identity = "";
  return {
    issue(next: string) {
      identity = next;
      return { generation: ++generation, identity };
    },
    owns(token: { generation: number; identity: string }) {
      return token.generation === generation && token.identity === identity;
    },
    invalidate() {
      generation += 1;
      identity = "";
    },
  };
}
