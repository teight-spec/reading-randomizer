const { detectAntiBot } = require("./antiBot");

function analyzeAntiBotSignal({ response = null, error = null, stageName = "unknown", redirectChain = [] } = {}) {
  const detector = response ? detectAntiBot(response) : null;
  const message = `${error?.message || ""} ${error?.code || ""}`;
  const http2Refused = /ERR_HTTP2_PROTOCOL_ERROR|ERR_HTTP2_SERVER_REFUSED_STREAM|refused stream/i.test(message);
  const unusualRedirectChain = redirectChain.length >= 5;
  const antiBotType = detector?.indicators?.[0] || (http2Refused ? "http2_refused_stream" : unusualRedirectChain ? "unusual_redirect_chain" : null);
  const blocked = Boolean(detector?.antiBot || detector?.blocked || http2Refused || unusualRedirectChain);

  return {
    blocked,
    antiBotType,
    stageName,
    indicators: detector?.indicators || (antiBotType ? [antiBotType] : []),
    cooldownRecommendationMs: blocked ? cooldownFor(antiBotType) : 0
  };
}

function eventFromSignal(signal, traceId = null) {
  return {
    stageName: signal.stageName || "unknown",
    ok: false,
    latencyMs: 0,
    strategySource: "anti-bot-intelligence",
    failureCategory: "blocked_by_bot",
    fallbackReason: signal.antiBotType || "anti_bot_detected",
    traceId
  };
}

function cooldownFor(type) {
  if (type === "captcha" || type === "cloudflare") return 60 * 60 * 1000;
  if (type === "akamai" || type === "http2_refused_stream") return 30 * 60 * 1000;
  return 15 * 60 * 1000;
}

module.exports = {
  analyzeAntiBotSignal,
  eventFromSignal
};
