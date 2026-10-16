/**
 * The exact questions used by the optional live smoke test and quoted in the README.
 *
 * `ASSERT_QUESTIONS` are Pharos development questions the published documentation is expected
 * to answer (they were chosen after checking the real service). `NO_GOOD_ANSWER_QUESTION` asks
 * for something the documentation does not cover, and is used to prove the CLI's no-answer
 * behaviour against the live service instead of only against a mock.
 */

export const ASSERT_QUESTIONS = [
  "What are the RPC URL and chain ID of Pharos Pacific Mainnet? Cite the documentation page you used.",
  "How do I deploy a smart contract to Pharos with Hardhat? Give the exact commands and the documentation page.",
  "Which network should a developer use for testing on Pharos, and what is its faucet situation according to the documentation?",
];

export const NO_GOOD_ANSWER_QUESTION =
  "According to the Pharos developer documentation, what was the exact USD closing price of PROS on Binance yesterday?";
