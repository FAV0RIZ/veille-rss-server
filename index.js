const express = require('express');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'VeilleRSS/1.0 (+https://github.com/veille-rss)' },
});
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // TTL 5 minutes

const PORT = process.env.PORT || 3000;

// ── Sources RSS par catégorie ─────────────────────────────────────────────────
const SOURCES = {
  actualites: [
    { name: 'Le Monde',      url: 'https://www.lemonde.fr/rss/une.xml' },
    { name: 'France Info',   url: 'https://www.francetvinfo.fr/titres.rss' },
    { name: '20 Minutes',    url: 'https://www.20minutes.fr/feeds/rss/une' },
    { name: 'L\'Obs',        url: 'https://www.nouvelobs.com/rss.xml' },
  ],
  culture: [
    { name: 'Télérama',      url: 'https://www.telerama.fr/rss/culture.xml' },
    { name: 'Les Inrocks',   url: 'https://www.lesinrocks.com/feed/' },
    { name: 'Arte',          url: 'https://www.arte.tv/fr/rss/videos.xml' },
    { name: 'France Culture', url: 'https://radiofrance-podcast.net/podcast09/rss_15701.xml' },
  ],
  sport: [
    { name: 'So Foot',       url: 'https://www.sofoot.com/feed/' },
    { name: 'Foot Mercato',  url: 'https://www.footmercato.net/feed/' },
    { name: 'Maxifoot',      url: 'https://www.maxifoot.fr/feed/' },
    { name: 'Rugbyrama',     url: 'https://www.rugbyrama.fr/rss.xml' },
  ],
  musique: [
    { name: 'Pure Charts',   url: 'https://www.purecharts.fr/flux/rss.xml' },
    { name: 'Les Inrocks Musique', url: 'https://www.lesinrocks.com/musique/feed/' },
    { name: 'Pitchfork',     url: 'https://pitchfork.com/rss/news/' },
  ],
  normandie: [
    { name: 'Tendance Ouest', url: 'https://www.tendanceouest.com/rss.php' },
    { name: 'Actu.fr Normandie', url: 'https://actu.fr/normandie/rss' },
    { name: 'France Bleu Normandie', url: 'https://www.francebleu.fr/rss/normandie' },
    { name: 'Normandie Actu', url: 'https://www.normandieactu.fr/feed/' },
  ],
  business: [
    { name: 'Les Échos',     url: 'https://www.lesechos.fr/rss/rss_une.xml' },
    { name: 'BFM Business',  url: 'https://bfmbusiness.bfmtv.com/rss/info/' },
    { name: 'La Tribune',    url: 'https://www.latribune.fr/rss/' },
    { name: 'Capital',       url: 'https://www.capital.fr/feed' },
  ],
  cinema: [
    { name: 'Allociné',      url: 'https://www.allocine.fr/rss/news.xml' },
    { name: 'Première',      url: 'https://www.premiere.fr/feed/' },
    { name: 'Le Bleu du Miroir', url: 'https://www.lebleudumiroir.fr/feed/' },
  ],
  international: [
    { name: 'RFI',           url: 'https://www.rfi.fr/fr/rss' },
    { name: 'France 24',     url: 'https://www.france24.com/fr/rss' },
    { name: 'Courrier International', url: 'https://www.courrierinternational.com/feed/all/rss.xml' },
    { name: 'Le Monde Diplomatique', url: 'https://www.monde-diplomatique.fr/recents.atom' },
  ],
};

const ALL_CATEGORIES = Object.keys(SOURCES);

// ── Middlewares ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json());

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fetchFeed(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.map((item) => ({
      title:       item.title?.trim() || '',
      link:        item.link || item.guid || '',
      description: stripHtml(item.contentSnippet || item.summary || item.content || ''),
      pubDate:     item.pubDate || item.isoDate || null,
      source:      source.name,
      sourceUrl:   source.url,
      image:       extractImage(item),
    }));
  } catch {
    return [];
  }
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function extractImage(item) {
  if (item.enclosure?.url) return item.enclosure.url;
  const match = (item.content || item['content:encoded'] || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

async function fetchCategory(category) {
  const cacheKey = `cat_${category}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const sources = SOURCES[category];
  const results = await Promise.allSettled(sources.map(fetchFeed));

  const items = results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
    .slice(0, 50);

  cache.set(cacheKey, items);
  return items;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/news?cat=actualites
// GET /api/news?cat=actualites,sport  (plusieurs catégories)
// GET /api/news  (toutes catégories)
app.get('/api/news', async (req, res) => {
  try {
    const requested = req.query.cat
      ? req.query.cat.split(',').map((c) => c.trim().toLowerCase()).filter((c) => SOURCES[c])
      : ALL_CATEGORIES;

    if (req.query.cat && requested.length === 0) {
      return res.status(400).json({
        error: 'Catégorie(s) invalide(s)',
        available: ALL_CATEGORIES,
      });
    }

    const results = await Promise.allSettled(requested.map(fetchCategory));

    const byCategory = {};
    requested.forEach((cat, i) => {
      byCategory[cat] = results[i].status === 'fulfilled' ? results[i].value : [];
    });

    const allItems = Object.values(byCategory)
      .flat()
      .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

    res.json({
      ok: true,
      total: allItems.length,
      categories: requested,
      cachedUntil: new Date(Date.now() + 300_000).toISOString(),
      data: byCategory,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/categories — liste des catégories disponibles
app.get('/api/categories', (_req, res) => {
  res.json({
    ok: true,
    categories: ALL_CATEGORIES.map((cat) => ({
      id: cat,
      sources: SOURCES[cat].map((s) => s.name),
    })),
  });
});

// GET /api/health — healthcheck pour Render
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), cacheKeys: cache.keys().length });
});

// GET / — accueil
app.get('/', (_req, res) => {
  res.json({
    name: 'veille-rss-server',
    version: '1.0.0',
    endpoints: {
      'GET /api/news':              'Tous les flux (toutes catégories)',
      'GET /api/news?cat=sport':    'Filtrer par catégorie',
      'GET /api/news?cat=sport,cinema': 'Plusieurs catégories',
      'GET /api/categories':        'Liste des catégories disponibles',
      'GET /api/health':            'Healthcheck',
    },
    categories: ALL_CATEGORIES,
  });
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`veille-rss-server démarré sur le port ${PORT}`);
  console.log(`Catégories : ${ALL_CATEGORIES.join(', ')}`);
});
