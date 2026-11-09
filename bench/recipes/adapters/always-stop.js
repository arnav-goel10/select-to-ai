// Degenerate: never acts and always reports that it stopped. It must not be
// able to score on anything except must-stop cells, which is why correct-stop
// is never reported without success on unmutated and repairable cells.
export default {
  name: "always-stop",
  async prepare() {
    return null;
  },
  async run() {
    return { claimedDone: false, answer: null, healed: false };
  },
};
