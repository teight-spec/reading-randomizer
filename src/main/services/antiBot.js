const CLOUDFARE_PATTERNS = [
  /attention required/i,
  /just a moment/i,
  /checking your browser/i,
  /cloudflare/i,
  /cf-chl/i,
  /cf-ray/i,
  /ddos protection by cloudflare/i,
  /managed challenge/i,
  /turnstile/i
];

const AKAMAI_PATTERNS = [
  /akamai/i,
  /bot manager/i,
  /akamai bot manager/i,
  /akamai technologies/i,
  /access denied/i,
  /reference #\d+\.\w+/i,
  /request blocked/i,
  /_abck/i,
  /bm_sz/i
];

const CAPTCHA_PATTERNS = [
  /captcha/i,
  /hcaptcha/i,
  /recaptcha/i,
  /verify you are human/i,
  /are you a human/i,
  /human verification/i
];

const JS_CHALLENGE_PATTERNS = [
  /enable javascript/i,
  /javascript is required/i,
  /challenge/i,
  /bot mitigation/i,
  /security check/i,
  /please wait while we check/i,
  /browser verification/i
];

const ACCESS_DENIED_PATTERNS = [
  /access denied/i,
  /forbidden/i,
  /request blocked/i,
  /denied by security policy/i,
  /not authorized/i,
  /unavailable due to legal reasons/i,
  /permission denied/i,
  /your request has been blocked/i
];

function detectAntiBot(response = {}) {
  const headersText = headersToText(response.headers);
  const body = `${response.text || ""}\n${headersText}`;
  const status = Number(response.status || 0);
  const matches = {
    cloudflare: anyMatch(body, CLOUDFARE_PATTERNS),
    akamai: anyMatch(body, AKAMAI_PATTERNS),
    captcha: anyMatch(body, CAPTCHA_PATTERNS),
    jsChallenge: anyMatch(body, JS_CHALLENGE_PATTERNS),
    accessDenied: anyMatch(body, ACCESS_DENIED_PATTERNS)
  };
  const antiBot = matches.cloudflare || matches.akamai || matches.captcha || matches.jsChallenge;
  const blocked = matches.accessDenied || status === 401 || status === 403 || status === 429 || status === 451;

  return {
    antiBot,
    blocked,
    matches,
    indicators: compactIndicators(matches),
    status
  };
}

function headersToText(headers = {}) {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(";") : value}`)
    .join("\n");
}

function anyMatch(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function compactIndicators(matches) {
  return Object.entries(matches)
    .filter(([, value]) => value)
    .map(([key]) => key);
}

module.exports = {
  detectAntiBot
};
