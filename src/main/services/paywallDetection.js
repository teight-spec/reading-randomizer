const cheerio = require("cheerio");

const HARD_PAYWALL_ATTR = /(?:^|[\s_-])(paywall|hard-?wall|gated-content|subscription-wall|piano-paywall)(?:$|[\s_-])/i;
const EXCLUDE_CONTAINERS = "header, nav, footer, aside, [role='banner'], [role='navigation'], [role='contentinfo'], [role='complementary']";
const PAYMENT_REQUIREMENT = /subscribe to continue(?: reading)?|subscription required|this article is for subscribers|subscribers?[ -]?only|pay (now )?to (continue|read|unlock)|unlock (the )?(full )?(article|story)|already a subscriber|purchase (a )?(subscription|article) to (continue|read)/i;
const NEWSLETTER_OR_PROMO = /subscribe to (our )?(newsletter|briefing)|sign up for (our )?(newsletter|briefing)|more stories like this/i;
const MIN_VISIBLE_ARTICLE_WORDS = 80;

function detectPaywallFromPage({ html = "", status = 200, error = null } = {}) {
  if (error) {
    const reason = classifyOriginalError(error);
    return result({
      paywalled: false,
      outcome: "original_failure",
      reason,
      evidence: `original_error:${reason}`,
      target: "original"
    });
  }

  const statusCode = Number(status || 0);
  if (statusCode === 401 || statusCode === 403 || statusCode === 429 || statusCode === 451) {
    return result({
      paywalled: false,
      outcome: "original_failure",
      reason: `http_${statusCode}`,
      evidence: `http_status:${statusCode}`,
      target: "original"
    });
  }
  if (statusCode === 408 || (statusCode >= 500 && statusCode <= 599)) {
    return result({
      paywalled: false,
      outcome: "original_failure",
      reason: `http_${statusCode}`,
      evidence: `http_status:${statusCode}`,
      target: "original"
    });
  }

  const page = String(html || "");
  if (!page.trim()) {
    return result({
      paywalled: false,
      outcome: "unknown_failure",
      reason: "empty_document",
      evidence: "empty_document",
      target: "original"
    });
  }

  if (hasCaptchaChallenge(page)) {
    return result({
      paywalled: false,
      outcome: "unknown_failure",
      reason: "captcha",
      evidence: "captcha_or_bot_challenge",
      target: "original"
    });
  }

  const dual = findDualPaywallEvidence(page);
  if (dual) {
    return result({
      paywalled: true,
      outcome: "paywall",
      reason: "payment_requirement_and_blocked_body",
      evidence: dual,
      target: "mirror"
    });
  }

  if (hasRegistrationWall(page)) {
    return result({
      paywalled: false,
      outcome: "unknown_failure",
      reason: "registration_wall",
      evidence: "registration_or_account_gate_without_blocked_payment",
      target: "original"
    });
  }

  if (hasLoginWall(page)) {
    return result({
      paywalled: false,
      outcome: "unknown_failure",
      reason: "login_wall",
      evidence: "login_form_without_hard_paywall",
      target: "original"
    });
  }

  return result({
    paywalled: false,
    outcome: "no_paywall",
    reason: "no_dual_paywall_evidence",
    evidence: "missing_payment_requirement_or_unblocked_body",
    target: "original"
  });
}

function result(fields) {
  return {
    paywalled: Boolean(fields.paywalled),
    outcome: fields.outcome,
    reason: fields.reason,
    evidence: fields.evidence,
    target: fields.target
  };
}

function classifyOriginalError(error) {
  const text = `${error?.kind || ""} ${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  if (error?.kind === "timeout" || /timed out|timeout/.test(text)) return "timeout";
  if (error?.code === "ENOTFOUND" || error?.code === "EAI_AGAIN") return "dns_failure";
  if (/econnrefused|connection refused/.test(text)) return "connection_refused";
  if (/econnreset|socket hang up/.test(text)) return "remote_closed";
  return "network_error";
}

function hasCaptchaChallenge(html) {
  return /recaptcha|h-captcha|hcaptcha|cf-challenge|challenges\.cloudflare|verify you are (a )?human/i.test(html);
}

function hasLoginWall(html) {
  const $ = cheerio.load(html);
  const forms = $("form").toArray();
  return forms.some((form) => {
    const $form = $(form);
    if ($form.parents(EXCLUDE_CONTAINERS).length) return false;
    const password = $form.find("input[type='password']").length > 0;
    const user = $form.find("input[type='email'], input[type='text'][name*='user' i], input[name*='login' i], input[name*='email' i]").length > 0;
    const action = `${$form.attr("action") || ""} ${$form.attr("id") || ""} ${$form.attr("class") || ""}`;
    return password && (user || /login|sign-?in|auth/i.test(action));
  });
}

function hasRegistrationWall(html) {
  const $ = cheerio.load(html);
  if ($("[id*='reg-wall' i], [id*='regwall' i], [class*='reg-wall' i], [class*='regwall' i], [data-reg-wall]").length) {
    return true;
  }
  const text = $("body").text().replace(/\s+/g, " ").slice(0, 4000);
  const hasAccountGate = /create (an )?account|register to (continue|read)|sign up to (continue|read)/i.test(text);
  const hasPasswordForm = $("form input[type='password']").length > 0;
  return hasAccountGate && hasPasswordForm;
}

function findDualPaywallEvidence(html) {
  const $ = cheerio.load(html);
  const payment = findPaymentRequirement($);
  const blocked = findBlockedBody($);
  if (payment && blocked) {
    return `payment:${payment};blocked:${blocked}`;
  }
  return null;
}

function findPaymentRequirement($) {
  const $scope = $("body").clone();
  $scope.find(EXCLUDE_CONTAINERS).remove();
  const text = $scope.text().replace(/\s+/g, " ").trim();
  if (NEWSLETTER_OR_PROMO.test(text) && !PAYMENT_REQUIREMENT.test(text)) return null;
  if (!PAYMENT_REQUIREMENT.test(text)) return null;
  const match = text.match(PAYMENT_REQUIREMENT);
  return match ? "article_access_requires_payment_or_subscription" : null;
}

function findBlockedBody($) {
  const $article = $("main, article, [role='main']").first();
  const hidden = collectHiddenArticleText($, $article);
  const visible = collectVisibleArticleText($, $article);
  const visibleWords = wordCount(visible);
  const hiddenWords = wordCount(hidden);

  if (hiddenWords >= 40 && hiddenWords > visibleWords) {
    return "remaining_article_hidden";
  }

  const hasGateOverlay = hasBlockingOverlay($);
  if (hasGateOverlay && visibleWords < MIN_VISIBLE_ARTICLE_WORDS) {
    return "short_visible_teaser_with_blocking_overlay";
  }

  if (isTruncatedArticle($article) && visibleWords < MIN_VISIBLE_ARTICLE_WORDS && hiddenWords >= 40) {
    return "truncated_article_with_hidden_remainder";
  }

  return null;
}

function collectVisibleArticleText($, $article) {
  const root = $article && $article.length ? $article : $("body");
  const $clone = root.clone();
  $clone.find("script, style, [hidden], [aria-hidden='true']").remove();
  $clone.find("[style]").each((_, el) => {
    const style = String($(el).attr("style") || "");
    if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) {
      $(el).remove();
    }
  });
  return $clone.text();
}

function collectHiddenArticleText($, $article) {
  const root = $article && $article.length ? $article : $("body");
  const parts = [];
  root.find("[hidden], [aria-hidden='true']").each((_, el) => {
    parts.push($(el).text());
  });
  root.find("[style]").each((_, el) => {
    const style = String($(el).attr("style") || "");
    if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) {
      parts.push($(el).text());
    }
  });
  return parts.join(" ");
}

function isTruncatedArticle($article) {
  if (!$article || !$article.length) return false;
  const cls = `${$article.attr("class") || ""} ${$article.attr("data-truncated") || ""}`;
  return /preview-only|truncated|metered-preview/i.test(cls) || $article.attr("data-truncated") === "true";
}

function hasBlockingOverlay($) {
  const overlays = $("body").children().add("[role='dialog'], [aria-modal='true']");
  return overlays.toArray().some((el) => {
    const $el = $(el);
    if ($el.parents(EXCLUDE_CONTAINERS).length) return false;
    const haystack = [$el.attr("id") || "", $el.attr("class") || "", $el.attr("data-testid") || "", $el.attr("data-paywall") || ""].join(" ");
    const text = $el.text();
    return HARD_PAYWALL_ATTR.test(haystack) || PAYMENT_REQUIREMENT.test(text) || $el.attr("aria-modal") === "true";
  });
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function decidePaywallAction(detection, { mirrorConfigured = false, firstMirror = null } = {}) {
  if (detection.paywalled && detection.outcome === "paywall") {
    if (mirrorConfigured && firstMirror) {
      return { action: "open_mirror_once", mirrorName: firstMirror.name || "mirror", retry: false };
    }
    return { action: "paywall_without_mirror", retry: false };
  }
  if (detection.outcome === "no_paywall") {
    return { action: "open_original", retry: false };
  }
  return { action: "report_original_or_unknown_failure", retry: false, reason: detection.reason };
}

module.exports = {
  detectPaywallFromPage,
  decidePaywallAction,
  findDualPaywallEvidence
};
