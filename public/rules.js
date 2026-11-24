export const categories = ["火锅", "川湘", "台湾", "其他中餐", "日韩", "其他亚洲", "西式", "快餐", "饮品"];
export const prices = ["15", "25", "40", "60", "100"];
export const meals = ["l", "d"];
export const defaults = {cat: "全部", price: "不限", meal: "any", off: [], norep: false};

export function eligible(restaurants, history, prefs) {
  const excluded = new Set(prefs.off);
  if (prefs.norep) {
    for (const entry of history.slice(0, 3)) excluded.add(entry.restaurantId);
  }
  return restaurants.filter(r => !excluded.has(r.id)
    && (prefs.cat === "全部" || r.category === prefs.cat)
    && (prefs.price === "不限" || (r.budgetUsd != null && r.budgetUsd <= Number(prefs.price)))
    && (prefs.meal === "any" || r.meals.includes(prefs.meal)));
}

export function mapUrl({address, nameEn, name, area}) {
  const url = new URL(address ? "https://www.google.com/maps/dir/" : "https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  if (address) {
    url.searchParams.set("destination", address);
    url.searchParams.set("dir_action", "navigate");
  } else {
    const city = area?.startsWith("Duarte 周边") ? "Duarte, CA" : area && area !== "待确认" ? area + ", CA" : "Los Angeles, CA";
    url.searchParams.set("query", (nameEn || name) + " near " + city);
  }
  return url.href;
}
