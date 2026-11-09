// Degenerate: does nothing and claims success.
export default {
  name: "do-nothing",
  async prepare() {
    return null;
  },
  async run() {
    return { claimedDone: true, answer: null, healed: false };
  },
};
