function dedupeArticles(articles) {
  const byUrl = new Map();
  for (const article of articles) {
    if (article.url && !byUrl.has(article.url)) byUrl.set(article.url, article);
  }
  return [...byUrl.values()];
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

module.exports = {
  dedupeArticles,
  shuffle
};
