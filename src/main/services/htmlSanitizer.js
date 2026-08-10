const { JSDOM } = require("jsdom");

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "caption",
  "code",
  "dd",
  "del",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul"
]);

const DROP_WITH_CONTENT = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "input",
  "link",
  "meta",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "template",
  "textarea",
  "video"
]);

const GLOBAL_ATTRIBUTES = new Set(["dir", "lang", "title"]);
const TAG_ATTRIBUTES = {
  a: new Set(["href"]),
  blockquote: new Set(["cite"]),
  img: new Set(["alt", "src"]),
  q: new Set(["cite"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  time: new Set(["datetime"])
};

function sanitizeArticleHtml(html = "", baseUrl = "") {
  const dom = new JSDOM(`<!doctype html><body>${String(html || "")}</body>`, {
    url: safeBaseUrl(baseUrl)
  });
  const { document } = dom.window;

  for (const element of [...document.body.querySelectorAll("*")]) {
    const tag = element.tagName.toLowerCase();
    if (ALLOWED_TAGS.has(tag)) continue;
    if (DROP_WITH_CONTENT.has(tag)) {
      element.remove();
    } else {
      element.replaceWith(...element.childNodes);
    }
  }

  for (const element of document.body.querySelectorAll("*")) {
    const tag = element.tagName.toLowerCase();
    const tagAttributes = TAG_ATTRIBUTES[tag] || new Set();
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (!GLOBAL_ATTRIBUTES.has(name) && !tagAttributes.has(name)) {
        element.removeAttribute(attribute.name);
      }
    }

    if (tag === "a") {
      normalizeUrlAttribute(element, "href", baseUrl, new Set(["http:", "https:"]));
      if (element.hasAttribute("href")) {
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noreferrer noopener");
      }
    }
    if (tag === "img") {
      normalizeUrlAttribute(element, "src", baseUrl, new Set(["https:"]));
      if (!element.hasAttribute("src")) {
        element.remove();
        continue;
      }
      element.setAttribute("loading", "lazy");
      element.setAttribute("decoding", "async");
      element.setAttribute("referrerpolicy", "no-referrer");
    }
    if (tag === "blockquote" || tag === "q") {
      normalizeUrlAttribute(element, "cite", baseUrl, new Set(["http:", "https:"]));
    }
    if (tag === "td" || tag === "th") {
      clampIntegerAttribute(element, "colspan", 1, 20);
      clampIntegerAttribute(element, "rowspan", 1, 200);
    }
  }

  return document.body.innerHTML;
}

function normalizeUrlAttribute(element, attribute, baseUrl, protocols) {
  const raw = String(element.getAttribute(attribute) || "").trim();
  if (!raw || raw.length > 4096) {
    element.removeAttribute(attribute);
    return;
  }
  try {
    const parsed = new URL(raw, safeBaseUrl(baseUrl));
    if (!protocols.has(parsed.protocol) || parsed.username || parsed.password) {
      element.removeAttribute(attribute);
      return;
    }
    element.setAttribute(attribute, parsed.toString());
  } catch {
    element.removeAttribute(attribute);
  }
}

function clampIntegerAttribute(element, attribute, min, max) {
  if (!element.hasAttribute(attribute)) return;
  const value = Number.parseInt(element.getAttribute(attribute), 10);
  if (!Number.isInteger(value)) {
    element.removeAttribute(attribute);
    return;
  }
  element.setAttribute(attribute, String(Math.max(min, Math.min(max, value))));
}

function safeBaseUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (["http:", "https:"].includes(parsed.protocol)) return parsed.toString();
  } catch {
    // Fall through to a non-routable HTTPS base.
  }
  return "https://invalid.local/";
}

module.exports = {
  sanitizeArticleHtml
};
