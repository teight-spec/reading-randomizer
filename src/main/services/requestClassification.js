function classifyFailure(error = {}, response = null) {
  const status = Number(response?.status || error.status || 0);
  const text = `${error?.message || ""} ${response?.text || ""}`.toLowerCase();

  if (error.kind === "timeout" || /timed out/.test(text)) return "timeout";
  if (error.kind === "aborted" || /abort|cancell?ed/.test(text)) return "aborted";
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") return "dns_failure";
  if (/ssl|tls|certificate|handshake/i.test(text) || /^ERR_SSL|^ERR_CERT/.test(error.code || "")) return "ssl_error";
  if (/connection refused|err_connection_refused|econnrefused/i.test(text) || error.code === "ECONNREFUSED") {
    return "connection_refused";
  }
  if (/connection closed|err_connection_closed|socket hang up|econnreset/i.test(text) || error.code === "ECONNRESET") {
    return "remote_closed";
  }
  if (status === 401 || status === 403 || status === 429 || status === 451) return "blocked_by_bot";
  if (/paywall|subscription required|subscriber only|subscribe/i.test(text)) return "paywall_detected";
  if (/empty|no articles?|no feed|not found/i.test(text) || status === 404) return "empty_content";
  if (/invalid html|could not extract|parse error|selector/i.test(text)) return "parser_failure";
  if (/network|fetch failed|socket|connection/i.test(text)) return "network_error";
  return "unknown";
}

function createTraceId(prefix = "req") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  classifyFailure,
  createTraceId
};
