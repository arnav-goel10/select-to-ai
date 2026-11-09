// The honest "no repair" baseline: the hand-written reference, replayed
// verbatim with its fixed CSS/XPath selectors. No healing, no model.
export default {
  name: "reference-replay",
  async prepare({ reference }) {
    return { reference };
  },
  async run({ page, artifact, vars }) {
    try {
      const answer = await artifact.reference(page, vars);
      return { claimedDone: true, answer: answer ?? null, healed: false };
    } catch (err) {
      return { claimedDone: false, answer: null, healed: false, error: String(err.message || err).split("\n")[0] };
    }
  },
};
