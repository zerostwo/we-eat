import http from "node:http";
import {randomInt, createHash, timingSafeEqual} from "node:crypto";
import {mkdirSync, readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {categories, prices, meals, eligible} from "./public/rules.js";

const asset = name => readFileSync(new URL(name, import.meta.url));
const dbPath = resolve(process.env.DB_PATH || "data/we-eat.sqlite");
mkdirSync(dirname(dbPath), {recursive: true});
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
function transaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

transaction(() => {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if ([1, 2, 3].includes(version)) return;
  if (version !== 0) throw Error("Unsupported database version: " + version);
  db.exec(`
    CREATE TABLE restaurants (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      type TEXT NOT NULL, category TEXT NOT NULL, area TEXT NOT NULL, opening TEXT NOT NULL,
      price TEXT NOT NULL, perPerson TEXT NOT NULL, note TEXT NOT NULL, meals TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE draws (
      id INTEGER PRIMARY KEY, requestId TEXT NOT NULL UNIQUE, restaurantId INTEGER NOT NULL REFERENCES restaurants(id),
      name TEXT NOT NULL, drawnAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    PRAGMA user_version=1;
  `);
  const add = db.prepare("INSERT INTO restaurants(id,name,type,category,area,opening,price,perPerson,note,meals) VALUES(?,?,?,?,?,?,?,?,?,?)");
  JSON.parse(asset("restaurants.json")).forEach((r, id) =>
    add.run(id, r.name, r.type, r.category, r.area, r.opening, r.price, r.perPerson, r.note, JSON.stringify(r.meals)));
});

transaction(() => {
  if (db.prepare("PRAGMA user_version").get().user_version !== 1) return;
  db.exec(`
    ALTER TABLE restaurants ADD COLUMN nameZh TEXT NOT NULL DEFAULT '';
    ALTER TABLE restaurants ADD COLUMN nameEn TEXT NOT NULL DEFAULT '';
    ALTER TABLE restaurants ADD COLUMN nameNote TEXT NOT NULL DEFAULT '';
    ALTER TABLE restaurants ADD COLUMN source TEXT NOT NULL DEFAULT '';
    ALTER TABLE restaurants ADD COLUMN budgetUsd INTEGER;
    ALTER TABLE restaurants ADD COLUMN inList INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE ratings (
      id INTEGER PRIMARY KEY, requestId TEXT NOT NULL UNIQUE,
      restaurantId INTEGER NOT NULL REFERENCES restaurants(id),
      author TEXT NOT NULL, score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX ratings_by_restaurant ON ratings(restaurantId, id DESC);
  `);
  const original = new Map(JSON.parse(asset("restaurants.json")).map(r => [r.name, r]));
  const existing = db.prepare("SELECT id, name, perPerson FROM restaurants").all();
  const update = db.prepare("UPDATE restaurants SET nameZh=?,nameEn=?,nameNote=?,budgetUsd=? WHERE id=?");
  for (const row of existing) {
    const seed = original.get(row.name);
    const hasHan = /\p{Script=Han}/u.test(row.name);
    const upper = row.perPerson.trim().match(/^\$?\s*(\d+(?:\.\d+)?)(?:\s*[-–—~至]\s*\$?(\d+(?:\.\d+)?))?(?:\s*美元)?$/);
    update.run(seed?.nameZh ?? (hasHan ? row.name : ""), seed?.nameEn ?? (hasHan ? "" : row.name),
      seed?.nameNote ?? (seed ? "" : "原有自定义店，另一语言名称待补充"),
      upper ? Math.ceil(Number(upper[2] || upper[1])) : null, row.id);
  }
  const match = db.prepare("SELECT id FROM restaurants WHERE name IN (?,?) COLLATE NOCASE OR nameZh=? OR nameEn=? COLLATE NOCASE");
  const insert = db.prepare(`INSERT INTO restaurants(name,nameZh,nameEn,nameNote,category,type,area,budgetUsd,perPerson,
    meals,source,inList,opening,price,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,'待确认','','')`);
  for (const r of JSON.parse(asset("catalog.json")).filter(r => !r.introduced)) {
    const found = match.get(r.nameZh, r.nameEn, r.nameZh, r.nameEn);
    if (found) {
      db.prepare("UPDATE restaurants SET nameZh=CASE WHEN nameZh='' THEN ? ELSE nameZh END, nameEn=CASE WHEN nameEn='' THEN ? ELSE nameEn END, source=? WHERE id=?")
        .run(r.nameZh,r.nameEn,r.source,found.id);
    } else insert.run(r.nameZh,r.nameZh,r.nameEn,r.nameNote,r.category,r.type,r.area,r.budgetUsd,r.perPerson,JSON.stringify(r.meals),r.source);
  }
  db.exec("PRAGMA user_version=2");
});

transaction(() => {
  if (db.prepare("PRAGMA user_version").get().user_version !== 2) return;
  db.exec(`
    ALTER TABLE restaurants ADD COLUMN address TEXT NOT NULL DEFAULT '';
    ALTER TABLE restaurants ADD COLUMN phone TEXT NOT NULL DEFAULT '';
    ALTER TABLE restaurants ADD COLUMN nearbyId INTEGER REFERENCES restaurants(id);
  `);
  const originals = JSON.parse(asset("restaurants.json"));
  const catalog = JSON.parse(asset("catalog.json"));
  const insert = db.prepare(`INSERT INTO restaurants(name,nameZh,nameEn,nameNote,type,category,area,
    address,phone,opening,price,perPerson,budgetUsd,note,meals,source,inList)
    VALUES(:nameZh,:nameZh,:nameEn,:nameNote,:type,:category,:area,
    :address,:phone,:opening,'',:perPerson,:budgetUsd,:note,:meals,:source,0)`);
  const update = db.prepare(`UPDATE restaurants SET nameZh=:nameZh,nameEn=:nameEn,nameNote=:nameNote,
    type=:type,category=:category,area=:area,address=:address,phone=:phone,opening=:opening,
    perPerson=:perPerson,budgetUsd=:budgetUsd,note=:note,meals=:meals,source=:source,revision=revision+1
    WHERE id=:id AND revision=1`);
  const findOriginal = db.prepare("SELECT id FROM restaurants WHERE id=? AND name=?");
  const findCatalog = db.prepare("SELECT id FROM restaurants WHERE name=? AND nameZh=? AND nameEn=? COLLATE NOCASE AND source<>''");
  const collision = db.prepare("SELECT id FROM restaurants WHERE name IN (?,?) OR nameZh=? OR nameEn=? COLLATE NOCASE");
  const alternatives = [];
  for (const [i, seed] of [...originals, ...catalog].entries()) {
    const {nameZh, nameEn, type, category, area, address, opening, perPerson, source} = seed;
    const numbers = perPerson.match(/\d+/g);
    const fields = {nameZh, nameEn, type, category, area, address, opening, perPerson, source,
      nameNote: seed.nameNote || "", phone: seed.phone || "", note: seed.note || "",
      budgetUsd: seed.budgetUsd ?? (numbers ? Number(numbers.at(-1)) : null), meals: JSON.stringify(seed.meals)};
    if (seed.introduced === 3) {
      if (!collision.get(nameZh, nameEn, nameZh, nameEn)) insert.run(fields);
      continue;
    }
    const row = i < originals.length ? findOriginal.get(i, seed.name) : findCatalog.get(nameZh, nameZh, nameEn);
    if (row && update.run({...fields, id: row.id}).changes && seed.alternativeEn) {
      alternatives.push([seed.alternativeEn, row.id]);
    }
  }
  const link = db.prepare(`UPDATE restaurants SET nearbyId=(
    SELECT id FROM restaurants WHERE nameEn=? COLLATE NOCASE AND address<>'' AND source<>'' LIMIT 1) WHERE id=?`);
  for (const [name, id] of alternatives) link.run(name, id);
  db.exec("PRAGMA user_version=3");
});

const adminToken = process.env.ADMIN_TOKEN || "";
const recent = db.prepare("SELECT id, restaurantId, name, drawnAt FROM draws ORDER BY id DESC LIMIT 8");
function restaurantRows(listOnly) {
  const where = listOnly ? "WHERE r.inList=1" : "";
  const rows = db.prepare(`SELECT r.*, coalesce(v.voteCount,0) AS voteCount, v.average, alt.nameZh AS nearbyName, alt.address AS nearbyAddress
    FROM restaurants r LEFT JOIN restaurants alt ON alt.id=r.nearbyId LEFT JOIN (
      SELECT restaurantId, COUNT(*) AS voteCount, ROUND(AVG(score),1) AS average FROM ratings GROUP BY restaurantId
    ) v ON v.restaurantId=r.id ${where} ORDER BY r.id`).all();
  return rows.map(r => ({...r, meals: JSON.parse(r.meals)}));
}
function state() {
  return {
    restaurants: restaurantRows(true),
    history: recent.all(),
    management: Boolean(adminToken)
  };
}
class InputError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function check(ok, message, status = 400) {
  if (!ok) throw new InputError(status, message);
}
function pick(body) {
  const {requestId, prefs} = body;
  check(typeof requestId === "string" && /^[0-9a-f]{32}$/i.test(requestId), "抽选编号无效。");
  check(prefs && ["全部", ...categories].includes(prefs.cat) && ["不限", ...prices].includes(prefs.price)
    && ["any", ...meals].includes(prefs.meal) && typeof prefs.norep === "boolean"
    && Array.isArray(prefs.off) && prefs.off.every(Number.isSafeInteger), "筛选条件无效。");
  return transaction(() => {
    const data = state();
    const pool = eligible(data.restaurants, data.history, prefs).map(r => r.id);
    const prior = db.prepare("SELECT restaurantId FROM draws WHERE requestId=?").get(requestId);
    if (prior) {
      if (!pool.includes(prior.restaurantId)) pool.push(prior.restaurantId);
      return {...data, pool, winner: prior.restaurantId};
    }
    if (!pool.length) return {...data, pool, winner: null};
    const winner = pool[randomInt(pool.length)];
    const restaurant = data.restaurants.find(r => r.id === winner);
    const name = restaurant.nameZh || restaurant.name;
    db.prepare("INSERT INTO draws(requestId,restaurantId,name) VALUES(?,?,?)").run(requestId, winner, name);
    return {...data, pool, winner, history: recent.all()};
  });
}
const digest = text => createHash("sha256").update(text).digest();
function textField(value, max, required = false) {
  check(typeof value === "string", "店铺或评分资料格式有误。");
  const text = value.trim();
  check(text.length <= max && (!required || text.length > 0), "请检查必填项和字数限制。");
  return text;
}
function addToList(id) {
  check(Number.isSafeInteger(id), "店铺编号无效。");
  check(db.prepare("UPDATE restaurants SET inList=1 WHERE id=?").run(id).changes, "找不到这家店。", 404);
  return state();
}
function saveRestaurant(body, admin) {
  const id = admin ? body.id : null;
  check(id === null || (Number.isSafeInteger(id) && Number.isSafeInteger(body.revision)), "店铺版本无效。");
  const zh = textField(body.nameZh, 100, true), en = textField(body.nameEn, 100, true);
  const category = body.category, budget = body.budgetUsd;
  check(categories.includes(category), "请选择菜系。");
  check(budget === null || (Number.isSafeInteger(budget) && budget > 0 && budget <= 5000), "请输入 1 至 5000 之间的人均预算（美元）。");
  check(Array.isArray(body.meals) && body.meals.length && body.meals.length <= 2
    && body.meals.every(m => meals.includes(m)), "请选择午饭或晚饭。");
  const area = textField(body.area,100) || "待确认", type = textField(body.type ?? "",100) || category;
  const opening = textField(body.opening ?? "",100) || "待确认", note = textField(body.note ?? "",300);
  const address = body.address === undefined ? null : textField(body.address, 220);
  const phone = body.phone === undefined ? null : textField(body.phone, 40);
  const mealList = JSON.stringify([...new Set(body.meals)]);
  return transaction(() => {
    const duplicate = db.prepare(`SELECT * FROM restaurants WHERE (nameZh=? OR nameEn=? COLLATE NOCASE
      OR name=? COLLATE NOCASE OR name=? COLLATE NOCASE) AND id != ? LIMIT 1`).get(zh,en,zh,en,id ?? -1);
    if (duplicate && !admin && duplicate.nameZh === zh && duplicate.nameEn.toLowerCase() === en.toLowerCase()) {
      return addToList(duplicate.id);
    }
    check(!duplicate, "已有同名餐厅，请从餐厅库选择。", 409);
    const perPerson = budget == null ? "待确认" : budget + " 美元";
    if (id === null) {
      db.prepare(`INSERT INTO restaurants(name,nameZh,nameEn,type,category,area,opening,price,perPerson,budgetUsd,note,meals,address,phone)
        VALUES(?,?,?,?,?,?,?,'',?,?,?,?,?,?)`).run(zh,zh,en,type,category,area,opening,perPerson,budget,note,mealList,address ?? "",phone ?? "");
    } else {
      const result = db.prepare(`UPDATE restaurants SET name=CASE WHEN nameZh=? THEN name ELSE ? END,
        nameNote=CASE WHEN nameZh=? AND nameEn=? THEN nameNote ELSE '' END,nameZh=?,nameEn=?,
        type=?,category=?,area=?,opening=?,perPerson=CASE WHEN budgetUsd IS ? THEN perPerson ELSE ? END,
        budgetUsd=?,price='',note=?,meals=?,address=coalesce(?,address),phone=coalesce(?,phone),
        source=CASE WHEN nameZh=? AND nameEn=? AND address=coalesce(?,address) THEN source ELSE '' END,
        nearbyId=CASE WHEN nameZh=? AND nameEn=? AND coalesce(?,address)='' THEN nearbyId END,revision=revision+1 WHERE id=? AND revision=?`)
        .run(zh,zh,zh,en,zh,en,type,category,area,opening,budget,perPerson,budget,note,mealList,address,phone,zh,en,address,zh,en,address,id,body.revision);
      check(result.changes === 1, "资料已变更，请重新选择这家店再编辑。", 409);
    }
    return state();
  });
}
function reviews(id) {
  check(db.prepare("SELECT 1 FROM restaurants WHERE id=? AND inList=1").get(id), "请先把餐厅加入想吃清单。", 404);
  const summary = db.prepare("SELECT count(*) AS voteCount, round(avg(score),1) AS average FROM ratings WHERE restaurantId=?").get(id);
  const entries = db.prepare("SELECT author,score,createdAt FROM ratings WHERE restaurantId=? ORDER BY id DESC LIMIT 20").all(id);
  return {...summary, entries};
}
function rate(body) {
  const {restaurantId, score, requestId} = body;
  check(Number.isSafeInteger(restaurantId) && Number.isInteger(score) && score >= 1 && score <= 5, "请选择 1 至 5 星。");
  check(typeof requestId === "string" && /^[0-9a-f]{32}$/i.test(requestId), "评分编号无效。");
  const author = textField(body.author ?? "", 40) || "匿名";
  return transaction(() => {
    check(db.prepare("SELECT 1 FROM restaurants WHERE id=? AND inList=1").get(restaurantId), "餐厅不在想吃清单中。", 404);
    const prior = db.prepare("SELECT restaurantId,score,author FROM ratings WHERE requestId=?").get(requestId);
    if (prior) check(prior.restaurantId === restaurantId && prior.score === score && prior.author === author, "请重新提交评分。", 409);
    else db.prepare("INSERT INTO ratings(requestId,restaurantId,author,score) VALUES(?,?,?,?)").run(requestId,restaurantId,author,score);
    return reviews(restaurantId);
  });
}
async function readBody(req) {
  check(req.headers["content-type"]?.split(";")[0] === "application/json", "需要 JSON 格式。", 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    check(size <= 65536, "请求过大。", 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new InputError(400, "JSON 格式有误。"); }
  check(body && typeof body === "object" && !Array.isArray(body), "需要 JSON 对象。");
  return body;
}
const html = ["text/html", asset("今天吃什么.html")];
const files = new Map([["/", html], [encodeURI("/今天吃什么.html"), html],
  ...["app.js", "community.js", "rules.js", "style.css"].map(name => ["/" + name, [name.endsWith(".css") ? "text/css" : "text/javascript", asset("public/" + name)]])]);
for (const [name, type] of [
  ["fonts.css", "text/css"], ["display.woff2", "font/woff2"], ["body.woff2", "font/woff2"],
  ["display-OFL.txt", "text/plain"], ["body-OFL.txt", "text/plain"]
]) files.set("/fonts/" + name, [type, asset("public/fonts/" + name)]);
function json(res, status, value) {
  res.writeHead(status, {"Content-Type": "application/json; charset=utf-8"}).end(JSON.stringify(value));
}
const server = http.createServer({requestTimeout: 15000, headersTimeout: 10000}, async (req, res) => {
  const path = req.url.split("?")[0];
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (req.method === "GET" || req.method === "HEAD") {
      if (path === "/healthz") {
        db.prepare("SELECT id FROM restaurants LIMIT 1").get();
        return json(res, 200, {ok: true});
      }
      if (path === "/api/state") return json(res, 200, state());
      if (path === "/api/catalog") return json(res, 200, restaurantRows(false));
      const ratingPath = path.match(/^\/api\/ratings\/(\d+)$/);
      if (ratingPath) return json(res, 200, reviews(Number(ratingPath[1])));
      const file = files.get(path);
      if (file) return res.writeHead(200, {"Content-Type": file[0] + "; charset=utf-8"}).end(file[1]);
    }
    if (req.method === "POST" && path === "/api/draws") {
      const result = pick(await readBody(req));
      return json(res, result.winner === null ? 409 : 200, result);
    }
    if (req.method === "POST" && path === "/api/ratings") return json(res, 200, rate(await readBody(req)));
    if (req.method === "POST" && path === "/api/wishlist") {
      const body = await readBody(req);
      return json(res, 200, body.id == null ? saveRestaurant(body, false) : transaction(() => addToList(body.id)));
    }
    if (req.method === "POST" && path === "/api/restaurants") {
      check(adminToken && timingSafeEqual(digest(req.headers.authorization || ""), digest("Bearer " + adminToken)), "管理密钥无效。", 403);
      return json(res, 200, saveRestaurant(await readBody(req), true));
    }
    json(res, 404, {error: "页面不存在。"});
  } catch (err) {
    if (!(err instanceof InputError)) console.error(err);
    json(res, err.status || 500, {error: err.status ? err.message : "数据库暂时不可用，请稍后重试。"});
  }
});
server.listen(Number(process.env.PORT || 8080), process.env.HOST || "0.0.0.0", () =>
  console.log("今天吃什么 · port " + server.address().port));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => db.close()));
