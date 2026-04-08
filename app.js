/* ============================================================
   BLOC 1/10 — Variables globales + Utils
   VERSION NETTOYÉE & STABLE
============================================================ */

const ALLEES = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N"];

const FAMILLES = {
    EL: "Électricité / Éclairage / Détection",
    RO: "Robinetterie",
    TA: "Tuyauterie & accessoires",
    EP: "Équipements process",
    IN: "Instrumentation",
    AC: "Accessoires / manutention",
    HV: "HVAC / ventilation",
    SE: "Supports / structures",
    CO: "Colliers / consommables",
    GA: "Gaines & réseaux",
    CS: "Consommables chantier",
    PE: "Protection",
    OU: "Outillage",
    EM: "Mécanique",
    CL: "Contrôle",
    GN: "Génie civil"
};

const BI_THRESHOLDS = {
    rotationAvg: {
        green: 1.0,
        orange: 0.3
    },
    dormantRate: {
        green: 0.3,
        orange: 0.6
    },
    stockRotationRatio: {
        green: 1000,
        orange: 3000
    }
};

function getBIColor(value, thresholds, invert = false) {
    // invert = true pour % dormants (plus c’est haut, plus c’est mauvais)
    if (!invert) {
        if (value >= thresholds.green) return "bi-green";
        if (value >= thresholds.orange) return "bi-orange";
        return "bi-red";
    } else {
        if (value <= thresholds.green) return "bi-green";
        if (value <= thresholds.orange) return "bi-orange";
        return "bi-red";
    }
}

function computeBIScore({
    rotationAvg,
    dormantRate,
    stockRotationRatio,
    articleCount
}) {

    let score = 0;

    // 🔹 Rotation moyenne (40 pts)
    if (rotationAvg >= 1) score += 40;
    else if (rotationAvg >= 0.3) score += 20;

    // 🔹 % articles dormants (30 pts)
    if (dormantRate <= 0.3) score += 30;
    else if (dormantRate <= 0.6) score += 15;

    // 🔹 Ratio stock / rotation (20 pts)
    if (stockRotationRatio <= 1000) score += 20;
    else if (stockRotationRatio <= 3000) score += 10;

    // 🔹 Complexité (10 pts)
    if (articleCount <= 20) score += 10;
    else if (articleCount <= 60) score += 5;

    return score;
}

let raw = [];
let dataset = [];
let filtered = [];
let GESTIONNAIRES = [];

let currentPage = 0;
const PAGE_SIZE = 60;

// Canvas principal + mini-map
let canvas, ctx;
let minimap, minimapCtx;
let tooltip;

// Navigation plan
let zoom = 1;
let offsetX = 0;
let offsetY = 0;
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;

// ================= ROTATION ARTICLES (N-1) =================
let expeditionsN1 = {}; // { articleCode : totalExpedié }
let ROTATION_YEARS = 1; // durée détectée du fichier expéditions
let expeditionsByLabel = {}; // { normalizedLabel: totalSorties }

const tableView     = document.getElementById("tableView");
const planView      = document.getElementById("planView");
const dashboardView = document.getElementById("dashboardView");
/* ------------------------------------------------------------
   Utils
------------------------------------------------------------ */
function normalizeLabel(value) {
    return String(value ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // accents
        .replace(/[^a-z0-9]/g, "")       // ⬅ IMPORTANT : pas d'espaces
        .trim();
}

// ✅ Alias pour compatibilité avec applyFilters()
function normalize(v) {
    return normalizeLabel(v);
}

function getCheckedValues(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array
        .from(container.querySelectorAll('input[type="checkbox"]:checked'))
        .map(cb => cb.value);
}
function hasChecked(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return false;

    return container.querySelectorAll(
        'input[type="checkbox"]:checked'
    ).length > 0;
}

function buildFluxMap(rows) {

    const byRef = {};
    expeditionsByLabel = {};

    rows.forEach(r => {

        const ref = String(r["Article"] || "").trim();
        const lib = normalizeLabel(r["Libellé"] || "");

        if (ref) {
            byRef[ref] = (byRef[ref] || 0) + 1;
        }

        if (lib) {
            expeditionsByLabel[lib] =
                (expeditionsByLabel[lib] || 0) + 1;
        }
    });

    return byRef;
}

function computeRotationRate(articleCode, label) {

    let sorties = expeditionsN1[articleCode];
    let usedFallback = false;

    // ✅ fallback par intitulé
    if (sorties === undefined && label) {
        const key = normalizeLabel(label);
        if (expeditionsByLabel[key] !== undefined) {
            sorties = expeditionsByLabel[key];
            usedFallback = true;
        }
    }

    sorties = sorties || 0;

    const stock = dataset.reduce((sum, e) =>
        sum + e.articles
            .filter(a => a.article === articleCode)
            .reduce((s,a) => s + a.qty, 0)
    , 0);

    if (!stock) {
        return {
            value: 0,
            tooltip: "Aucune rotation détectée"
        };
    }

    const rotation = +((sorties / stock) / ROTATION_YEARS).toFixed(2);

    // ✅ tooltip construit ICI
    let tooltip =
        `Rotation moyenne : ${rotation} par an\n` +
        `Calculée sur 4 ans`;

    if (usedFallback) {
        tooltip += `\n⚠️ Correspondance par intitulé`;
    }

    return {
        value: rotation,
        tooltip
    };
}

function computeTopDormantArticles(limit = 5) {

    const map = new Map();

    dataset.forEach(e => {
        e.articles.forEach(a => {

            const key = a.article;
            if (map.has(key)) return; // éviter doublons

            const rot = computeRotationRate(a.article, a.lib);

            // ✅ EXCLURE :
            // - pas de donnée
            // - rotation 0 (pas de flux du tout)
            if (!rot || rot.value <= 0) return;

            map.set(key, {
                article: a.article,
                lib: a.lib,
                rotation: rot.value,
                tooltip: rot.tooltip
            });
        });
    });

    // ✅ tri : les plus faibles rotations d'abord
    return Array.from(map.values())
        .sort((a, b) => a.rotation - b.rotation)
        .slice(0, limit);
}

function renderTopDormantList() {

    const ul = document.getElementById("topDormantList");
    if (!ul) return;

    ul.innerHTML = "";

    const top = computeTopDormantArticles(5);

    if (top.length === 0) {
        ul.innerHTML = "<li>Aucun article dormant détecté</li>";
        return;
    }

    top.forEach((item, i) => {
        const li = document.createElement("li");

        li.innerHTML = `
            <span class="ref">
                ${i + 1}. ${item.article}
            </span>
            <span class="rot" title="${item.tooltip}">
                ${item.rotation.toFixed(2)} /an
            </span>
        `;

        ul.appendChild(li);
    });
}

function rotationClass(rate) {
    if (rate === 0) return "rotation-none";
    if (rate < 1)  return "rotation-low";
    if (rate < 5)  return "rotation-medium";
    return "rotation-high";
}

function computeYearSpanFromExpeditions(rows) {

    let minTime = Infinity;
    let maxTime = -Infinity;

    rows.forEach(r => {
        const raw = r["Date conf"];
        if (!raw) return;

        // ✅ parsing DD/MM/YYYY
        const parts = String(raw).split("/");
        if (parts.length !== 3) return;

        const day   = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1; // JS months
        const year  = parseInt(parts[2], 10);

        const d = new Date(year, month, day);
        const t = d.getTime();

        if (!isNaN(t)) {
            if (t < minTime) minTime = t;
            if (t > maxTime) maxTime = t;
        }
    });

    if (minTime === Infinity || maxTime === -Infinity) {
        return 1;
    }

    const diffYears =
        (maxTime - minTime) / (1000 * 60 * 60 * 24 * 365);

    return Math.max(1, diffYears);
}

function computeTopRotations(limit = 5) {

    const map = new Map();
    // mapKey = articleCode
    // value = { article, lib, rotation, tooltip }

    dataset.forEach(e => {
        e.articles.forEach(a => {
            const key = a.article;

            // éviter recalcul si déjà traité
            if (map.has(key)) return;

            const rot = computeRotationRate(a.article, a.lib);

            if (rot.value > 0) {
                map.set(key, {
                    article: a.article,
                    lib: a.lib,
                    rotation: rot.value,
                    tooltip: rot.tooltip
                });
            }
        });
    });

    return Array.from(map.values())
        .sort((a, b) => b.rotation - a.rotation)
        .slice(0, limit);
}

function getFamilleFromGest(gest) {
    if (!gest) return "Non classée";
    const prefix = gest.substring(0, 2).toUpperCase();
    return FAMILLES[prefix] || "Autre";
}

function computeFamilleStats() {

    const stats = {};

    dataset.forEach(e => {
        e.articles.forEach(a => {

            const fam = a.famille || "Non classée";

            if (!stats[fam]) {
                stats[fam] = {
                    famille: fam,
                    stockTotal: 0,
                    articles: new Set(),
                    rotations: [],
                    rotationMax: 0,
                    topArticleLabel: ""
                };
            }

            // 🔹 stock
            stats[fam].stockTotal += a.qty;
            stats[fam].articles.add(a.article);

            // 🔹 rotation article
            const rotObj = computeRotationRate(a.article, a.lib);
            const rot = rotObj.value || 0;

            stats[fam].rotations.push(rot);

            // 🔹 rotation max + article associé
            if (rot > stats[fam].rotationMax) {
                stats[fam].rotationMax = rot;
                stats[fam].topArticleLabel =
                    `${a.article} – ${a.lib}`;
            }
        });
    });

    // 🔹 calcul BI par famille
    return Object.values(stats).map(f => {

        const articleCount = f.articles.size;

        const rotationAvg =
            f.rotations.length
                ? f.rotations.reduce((s, r) => s + r, 0) / f.rotations.length
                : 0;

        const dormantCount =
            f.rotations.filter(r => r < 0.2).length;

        const dormantRate =
            f.rotations.length
                ? dormantCount / f.rotations.length
                : 0;

        const stockRotationRatio =
            rotationAvg > 0
                ? f.stockTotal / rotationAvg
                : Infinity;

        const biScore = computeBIScore({
            rotationAvg,
            dormantRate,
            stockRotationRatio,
            articleCount
        });

        return {
            famille: f.famille,
            articlesDistincts: articleCount,
            stockTotal: f.stockTotal,
            rotationAvg: rotationAvg.toFixed(2),
            rotationMax: f.rotationMax.toFixed(2),
            dormantRate: (dormantRate * 100).toFixed(0),
            stockRotationRatio: Math.round(stockRotationRatio),
            topArticleLabel: f.topArticleLabel,
            biScore
        };
    });
}

function renderFamilleAnalysis() {

    const tbody = document.getElementById("familleTableBody");
    if (!tbody) return;

    // ✅ tri BI : familles les plus problématiques en haut
    const rows = computeFamilleStats()
        .sort((a, b) => a.biScore - b.biScore);

    tbody.innerHTML = "";

    rows.forEach(f => {

        const tr = document.createElement("tr");

        // ✅ choix de la couleur du score BI
        const scoreClass =
            f.biScore >= 75 ? "bi-green" :
            f.biScore >= 50 ? "bi-orange" :
                              "bi-red";

        tr.innerHTML = `
<td>${f.famille}</td>

<td>${f.articlesDistincts}</td>

<td>${f.stockTotal}</td>

<td>
  <span class="bi-badge ${getBIColor(
      f.rotationAvg,
      BI_THRESHOLDS.rotationAvg
  )}"
  title="Rotation moyenne annuelle de la famille">
    ${f.rotationAvg}
  </span>
</td>

<td>${f.rotationMax}</td>

<td title="${f.topArticleLabel}">
  ${f.topArticleLabel.split("–")[0]}
</td>

<td>
  <span class="bi-badge ${getBIColor(
      f.dormantRate / 100,
      BI_THRESHOLDS.dormantRate,
      true
  )}"
  title="Pourcentage d’articles de la famille à faible ou aucune rotation">
    ${f.dormantRate} %
  </span>
</td>

<td>
  <span class="bi-badge ${getBIColor(
      f.stockRotationRatio,
      BI_THRESHOLDS.stockRotationRatio,
      true
  )}"
  title="Stock total de la famille divisé par sa rotation moyenne">
    ${f.stockRotationRatio}
  </span>
</td>

<td>
  <strong class="bi-score ${scoreClass}"
          title="Score BI global (santé de la famille)">
    ${f.biScore}
  </strong>
</td>
`;

        tbody.appendChild(tr);
    });
}

/* ============================================================
   BLOC 2/10 — Import XLSX
============================================================ */

document.getElementById("fileInput").addEventListener("change", async (e) => {

    const file = e.target.files[0];
    if (!file) return;

    try {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: "array" });

        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        raw = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        buildDataset();
    }
    catch (err) {
        console.error("Erreur import Excel :", err);
        alert("Impossible de lire ce fichier Excel.");
    }
});

document.getElementById("expeditionsInput")
    .addEventListener("change", async e => {

    const file = e.target.files[0];
    if (!file) return;

    try {
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];

        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        // ✅ construction des flux
        expeditionsN1 = buildFluxMap(rows);

        // ✅ calcul automatique de la durée couverte
        ROTATION_YEARS = computeYearSpanFromExpeditions(rows);

        // ✅ affichage sécurisé dans l’UI
        const info = document.getElementById("rotationInfo");
        if (info) {
            info.textContent =
                `Rotation calculée sur ${ROTATION_YEARS.toFixed(1)} an(s)`;
        }

        console.log(
            "Durée expéditions détectée :",
            ROTATION_YEARS.toFixed(2),
            "an(s)"
        );

        refresh();
    }
    catch (err) {
        console.error("Erreur import expéditions :", err);
        alert("Impossible de lire le fichier des expéditions.");
    }
});


/* ============================================================
   BLOC 3/10 — NIV + Construction du Dataset
============================================================ */

/* Configuration des niveaux par allée / travée */
const NIV = {
    "A":{1:"J",2:"J",3:"I",4:"I",5:"I",6:"I",7:"I",8:"I",9:"I",10:"H",11:"H",12:"H",13:"H",14:"H",15:"H",16:"H"},
    "B":{1:"J",2:"J",3:"J",4:"J",5:"J",6:"J",7:"J",8:"J",9:"J",10:"I",11:"I",12:"J",13:"J",14:"J",15:"J",16:"J"},
    "C":{1:"J",2:"J",3:"J",4:"J",5:"J",6:"J",7:"J",8:"J",9:"J",10:"I",11:"I",12:"J",13:"J",14:"J",15:"J",16:"J"},
    "D":{1:"J",2:"J",3:"J",4:"J",5:"J",6:"J",7:"J",8:"J",9:"J",10:"J",11:"J",12:"J",13:"J",14:"J",15:"J",16:"J"},
    "E":{1:"J",2:"J",3:"J",4:"J",5:"J",6:"J",7:"J",8:"J",9:"J",10:"J",11:"J",12:"J",13:"J",14:"J",15:"J",16:"J"},
    "F":{1:"J",2:"J",3:"H",4:"H",5:"H",6:"H",7:"H",8:"H",9:"H",10:"I",11:"I",12:"J",13:"J",14:"J",15:"J",16:"J"},
    "G":{1:"J",2:"J",3:"H",4:"H",5:"H",6:"H",7:"H",8:"H",9:"H",10:"I",11:"I",12:"J",13:"J",14:"J",15:"J",16:"J"},
    "H":{1:"J",2:"J",3:"J",4:"J",5:"J",6:"J",7:"J",8:"J",9:"J",10:"J",11:"J",12:"J",13:"J",14:"J",15:"J",16:"J"},
    "I":{1:"J",2:"J",3:"J",4:"J",5:"J",6:"J",7:"J",8:"J",9:"J",10:"J",11:"J",12:"J",13:"J",14:"J",15:"J",16:"J"},
    "J":{1:"G",2:"G",3:"F",4:"F",5:"F",6:"F",7:"F",8:"F",9:"F",10:"G",11:"G",12:"G",13:"G",14:"G",15:"G",16:"G"},
    "K":{1:"G",2:"G",3:"F",4:"F",5:"F",6:"F",7:"F",8:"F",9:"F",10:"G",11:"G",12:"G",13:"G",14:"G",15:"G",16:"G"},
    "L":{1:"J",2:"J",3:"I",4:"I",5:"I",6:"I",7:"I",8:"I",9:"I",10:"I",11:"I",12:"I",13:"I",14:"I",15:"I",16:"I"},
    "M":{1:"J",2:"J",3:"I",4:"I",5:"I",6:"I",7:"I",8:"I",9:"I",10:"H",11:"H",12:"H",13:"H",14:"H",15:"H",16:"H"},
    "N":{1:"J",2:"J",3:"J",4:"J",5:"J",6:"J",7:"J",8:"J",9:"J",10:"I",11:"I",12:"I",13:"H",14:"H",15:"H",16:"H"}
};

/* Ordre logique des niveaux */
const LEVEL_ORDER = ["A","B","C","D","E","F","G","H","I","J"];

function getLevelsUpTo(maxLevel){
    return LEVEL_ORDER.slice(0, LEVEL_ORDER.indexOf(maxLevel) + 1);
}

/* Construction du dataset principal */
function buildDataset(){

    const map = {};

    // Gestionnaires uniques
    GESTIONNAIRES = [
        ...new Set(
            raw.map(r => (r["Gest."] || "").trim()).filter(Boolean)
        )
    ].sort();

    // Emplacements occupés (depuis Excel)
    raw.forEach(row => {

        const A   = (row["Allée"] || "").trim().toUpperCase();
        const T   = parseInt(row["Travée"]);
        const N   = (row["Niveau"] || "").trim().toUpperCase();
        const POS = parseInt(row["Numéro"]);

        if (!A || !T || !N || !POS) return;

        const key = `${A}-${T}-${N}-${POS}`;
        if (!map[key]) map[key] = { A, T, N, POS, articles: [] };

        let q = row["Stock disponible"];
        if (typeof q === "string") {
            q = q.replace(",", ".").replace(/[^0-9.-]/g, "");
        }
        q = parseFloat(q);
        if (isNaN(q)) q = 0;

        map[key].articles.push({
    article: String(row["Article"] || "").trim(),
    lib: row["Libellé"] || "",
    gest: (row["Gest."] || "").trim(),
    famille: getFamilleFromGest(row["Gest."]),
    qty: q
});
    });

    // Emplacements vides générés depuis NIV
    Object.keys(NIV).forEach(A => {
        Object.keys(NIV[A]).forEach(strT => {

            const T = parseInt(strT);
            const levels = getLevelsUpTo(NIV[A][T]);

            [1,2,3,4].forEach(POS => {
                levels.forEach(N => {
                    const key = `${A}-${T}-${N}-${POS}`;
                    if (!map[key]) {
                        map[key] = { A, T, N, POS, articles: [] };
                    }
                });
            });
        });
    });

    // Dataset final enrichi
    dataset = Object.values(map).map(e => {

        const qty = e.articles.reduce((s,a) => s + a.qty, 0);

        const status =
            qty === 0 ? "vide" :
            qty <= 5  ? "faible" :
            qty <= 20 ? "moyen" :
                        "plein";

        return {
            id: `${e.A}${String(e.T).padStart(2,"0")}${e.N}${e.POS}`,
            ...e,
            qty,
            status
        };
    });

    populateGestSelect();
    populateFamilleFilter();
    refresh();
}
/* ============================================================
   BLOC 4/10 — Sélecteur Gestionnaire + Filtres
============================================================ */

/* -----------------------------
   Sélecteur Gestionnaire
----------------------------- */
function populateGestSelect() {
    const group = document.getElementById("filterGest");
    if (!group) return;

    const content = group.querySelector(".filter-content");
    if (!content) return;

    content.innerHTML = "";

    GESTIONNAIRES.forEach(g => {
        const label = document.createElement("label");
        label.innerHTML = `<input type="checkbox" value="${g}"> ${g}`;
        content.appendChild(label);
    });
}
function populateFamilleFilter() {

    const group = document.getElementById("filterFamille");
    if (!group) return;

    const content = group.querySelector(".filter-content");
    if (!content) return;

    content.innerHTML = "";

    const famillesUniques = [
        ...new Set(
            dataset.flatMap(e =>
                e.articles.map(a => a.famille).filter(Boolean)
            )
        )
    ].sort();

    famillesUniques.forEach(f => {
        const label = document.createElement("label");
        label.innerHTML = `
            <input type="checkbox" value="${f}">
            ${f}
        `;
        content.appendChild(label);
    });
}
function populatePosFilter() {
    const group = document.getElementById("filterPos");
    if (!group) return;

    const content = group.querySelector(".filter-content");
    if (!content) return;

    content.innerHTML = "";

    for (let p = 1; p <= 4; p++) {
        const label = document.createElement("label");
        label.innerHTML = `<input type="checkbox" value="${p}"> ${p}`;
        content.appendChild(label);
    }
}

/* -----------------------------
   Références DOM filtres
   (déclarées AVANT usage)
----------------------------- */
const filterText   = document.getElementById("filterText");
const filterA      = document.getElementById("filterA");
const filterT      = document.getElementById("filterT");
const filterN      = document.getElementById("filterN");
const filterPos    = document.getElementById("filterPos");
const filterStatus = document.getElementById("filterStatus");
const filterGest   = document.getElementById("filterGest");

/* -----------------------------
   Application des filtres
----------------------------- */
function applyFilters() {

    if (!filterText) return;

    const txt = normalize(filterText.value || "");

    // ✅ TOUS LES FILTRES SONT DÉCLARÉS AVANT
    const FA = getCheckedValues("filterA").map(v => v.toUpperCase());
    const FT = getCheckedValues("filterT").map(v => parseInt(v));
    const FN = getCheckedValues("filterN").map(v => v.toUpperCase());
    const FP = getCheckedValues("filterPos").map(v => parseInt(v));
    const FS = getCheckedValues("filterStatus");
    const FG = getCheckedValues("filterGest").map(v => v.toUpperCase());
    const FF = getCheckedValues("filterFamille");

    filtered = dataset.filter(e => {

        if (FA.length && !FA.includes(e.A)) return false;
        if (FT.length && !FT.includes(e.T)) return false;
        if (FN.length && !FN.includes(e.N)) return false;
        if (FP.length && !FP.includes(e.POS)) return false;
        if (FS.length && !FS.includes(e.status)) return false;

        if (FG.length && !e.articles.some(a =>
            FG.includes((a.gest || "").toUpperCase())
        )) return false;

       if (FF.length && !e.articles.some(a =>
       FF.includes(a.famille)
       )) return false;

        // ✅ Recherche texte (inchangée)
        if (txt !== "") {
            const matchID   = normalize(e.id).includes(txt);
            const matchArt  = e.articles.some(a => normalize(a.article).includes(txt));
            const matchLib  = e.articles.some(a => normalize(a.lib).includes(txt));
            const matchGest = e.articles.some(a => normalize(a.gest).includes(txt));

            if (!matchID && !matchArt && !matchLib && !matchGest)
                return false;
        }

        return true;
    });

    currentPage = 0;
}

/* ============================================================
   BLOC 5/10 — Stats latérales + Histogramme + KPI
============================================================ */

/* -----------------------------
   Indicateurs latéraux
----------------------------- */
function updateIndicators() {

    if (!dataset.length) return;

    // === GLOBAL ===
    const totalLocations        = dataset.length;
    const totalOccupiedGlobal   = dataset.filter(e => e.qty > 0).length;

    // === FILTRÉ ===
    const filteredLocations     = filtered.length;
    const filteredOccupied      = filtered.filter(e => e.qty > 0).length;

    // === TAUX ===

    // 1️⃣ Taux général (occupés / total)
    const fillRateGlobal =
        totalLocations > 0
            ? ((filteredOccupied / totalLocations) * 100).toFixed(1)
            : "0.0";

    // 2️⃣ Taux sur les occupés seulement
    const fillRateOnOccupied =
        totalOccupiedGlobal > 0
            ? ((filteredOccupied / totalOccupiedGlobal) * 100).toFixed(1)
            : "0.0";

    // === AFFICHAGE ===
    sideFillRate.textContent = fillRateGlobal + "%";
    sideFillRateOccupied.textContent = fillRateOnOccupied + "%";

    sideCount.textContent = filteredLocations;
    sideQty.textContent   = filtered.reduce((s,e)=>s+e.qty,0);

    drawStatusChart();
}

renderTopRotations();

function renderTopRotations() {

    const ul = document.getElementById("topRotationList");
    if (!ul) return;

    ul.innerHTML = "";

    const top = computeTopRotations(5);

    if (top.length === 0) {
        ul.innerHTML = "<li>Aucune rotation disponible</li>";
        return;
    }

    top.forEach((item, i) => {
        const li = document.createElement("li");

        li.innerHTML = `
            <span class="ref">
                ${i + 1}. ${item.article}
            </span>
            <span class="rot" title="${item.tooltip}">
                ${item.rotation.toFixed(2)} /an
            </span>
        `;

        ul.appendChild(li);
    });
}

/* -----------------------------
   Histogramme des statuts
----------------------------- */
function drawStatusChart() {

    const canvas = document.getElementById("statusChart");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");

    canvas.width  = canvas.clientWidth;
    canvas.height = 140;

    ctx.clearRect(0,0,canvas.width,canvas.height);

    const counts = {
        plein:  filtered.filter(e=>e.status==="plein").length,
        moyen:  filtered.filter(e=>e.status==="moyen").length,
        faible: filtered.filter(e=>e.status==="faible").length,
        vide:   filtered.filter(e=>e.status==="vide").length
    };

    const colors = {
        plein:"#2e7d32",
        moyen:"#f2c200",
        faible:"#f57c00",
        vide:"#d32f2f"
    };

    const labels = Object.keys(counts);
    const max    = Math.max(...Object.values(counts), 1);

    let x = 25;
    const gap = 30, barWidth = 40;

    labels.forEach(st => {

        const val = counts[st];
        const h   = (val / max) * 100;

        ctx.fillStyle = colors[st];
        ctx.fillRect(x, canvas.height - h - 25, barWidth, h);

        ctx.fillStyle = "#333";
        ctx.textAlign = "center";
        ctx.font = "bold 13px 72-Regular, sans-serif";

        ctx.fillText(val, x + barWidth/2, canvas.height - h - 32);
        ctx.fillText(st, x + barWidth/2, canvas.height - 8);

        x += barWidth + gap;
    });
}

/* -----------------------------
   KPI (Dashboard)
----------------------------- */
function computeKPI() {
    return {
        totalArticles: new Set(
            dataset.flatMap(e => e.articles.map(a => a.article))
        ).size,

        totalQty: dataset.reduce((s,e)=>s+e.qty,0),

        usedLocations: dataset.filter(e=>e.qty>0).length,

        emptyLocations: dataset.filter(e=>e.qty===0).length,

        totalLocations: dataset.length,   // ✅ NOMBRE TOTAL D’EMPLACEMENTS

        totalGest: GESTIONNAIRES.length
    };
}

function renderDashboardKPI() {

    const box = document.getElementById("kpiDashboard");
    if (!box) return;

    const kpi = computeKPI();

    box.innerHTML = `
        <div class="kpi-card"><b>${kpi.totalArticles}</b><br>Articles distincts</div>
        <div class="kpi-card"><b>${kpi.totalQty}</b><br>Quantité totale</div>
<div class="kpi-card">
    <b>${kpi.totalLocations}</b><br>
    Emplacements totaux
</div>
        <div class="kpi-card"><b>${kpi.usedLocations}</b><br>Emplacements utilisés</div>
        <div class="kpi-card"><b>${kpi.emptyLocations}</b><br>Emplacements vides</div>
        <div class="kpi-card"><b>${kpi.totalGest}</b><br>Gestionnaires</div>
    `;
}


/* ============================================================
   BLOC 6/10 — Tableau + Pagination
============================================================ */

function renderTable() {

    const tbody = document.getElementById("tableBody");
    if (!tbody) return;

    tbody.innerHTML = "";

    const start = currentPage * PAGE_SIZE;
    const end   = start + PAGE_SIZE;
    const slice = filtered.slice(start, end);

    slice.forEach(e => {

       const articleHTML = `
    <div class="article-list">
        ${e.articles.map(a => {

            const rot = computeRotationRate(a.article, a.lib);

            return `
                <div class="article-item">
                    <div class="article-header">
                        <strong class="article-code">
                            ${a.article}
                        </strong>

                       <span
    class="rotation-badge ${rotationClass(rot.value)}"
    data-tooltip="${rot.tooltip}">
    ${rot.value}
</span>
                       
                    </div>

                    <div class="article-lib">
                        ${a.lib}
                    </div>

                    <div class="article-meta">
                        Gest : ${a.gest || "-"}
                    </div>

                    <div class="article-meta">
                        Qté : ${a.qty}
                    </div>
<div class="article-meta">
    Famille : ${a.famille}
</div>
                </div>
            `;
        }).join("")}
    </div>
`;

        const tr = document.createElement("tr");
        tr.setAttribute("data-id", e.id);
       
        tr.innerHTML = `
    <td>${e.id}</td>
    <td>${e.A}</td>
    <td>${e.T}</td>
    <td>${e.N}</td>
    <td>${e.POS}</td>
    <td>${articleHTML}</td>
    <td>${e.qty}</td>
    <td><span class="badge ${e.status}">${e.status}</span></td>
`;

        tr.addEventListener("mouseenter", () => highlightInPlan(e));
        tr.addEventListener("mouseleave", clearPlanHighlight);
        tr.addEventListener("dblclick", () => centerOn(e));

        tbody.appendChild(tr);
    });

    renderPagination();
    updateIndicators();
}

/* -----------------------------
   Pagination
----------------------------- */
function renderPagination(){

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    const pageInfo   = document.getElementById("pageInfo");
    if (!pageInfo) return;

    if (totalPages <= 1) {
        pageInfo.textContent = "";
        return;
    }

    pageInfo.textContent = `Page ${currentPage + 1} / ${totalPages}`;
}

document.getElementById("pagePrev").addEventListener("click", () => {
    if (currentPage > 0) {
        currentPage--;
        renderTable();
    }
});

document.getElementById("pageNext").addEventListener("click", () => {
    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    if (currentPage < totalPages - 1) {
        currentPage++;
        renderTable();
    }
});

/* ============================================================
   BLOC 7/10 — Plan 2D multi-niveaux (CORRIGÉ)
============================================================ */

function isLevelOccupied(A, T, N, POS) {
    const found = dataset.find(e =>
        e.A === A && e.T === T && e.N === N && e.POS === POS
    );
    return found ? found.qty > 0 : false;
}
function drawPlan() {
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();

    ctx.translate(offsetX, offsetY);
    ctx.scale(zoom, zoom);

    const TRAVE_WIDTH  = 120;
    const POS_WIDTH    = TRAVE_WIDTH / 4;
    const ALLEE_GAP    = 260;
    const LEVEL_HEIGHT = 18;

    /* ==========================
       LÉGENDE CANVAS (À GARDER)
       ========================== */

    // Travées (horizontal en haut)
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.font = "bold 36px Arial";          // ✅ PLUS GROS
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";

    for (let T = 1; T <= 16; T++) {
        const x = (T - 1) * TRAVE_WIDTH + TRAVE_WIDTH / 2;
        ctx.fillText(T, x, -20);
    }
    ctx.restore();

    // Allées (vertical à gauche)
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.font = "bold 36px Arial";          // ✅ PLUS GROS
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    ALLEES.forEach((A, idxA) => {
        const row = ALLEES.length - idxA - 1;
        const y = row * ALLEE_GAP + ALLEE_GAP / 2;
        ctx.fillText(A, -25, y);
    });
    ctx.restore();

    /* ==========================
       DESSIN DES EMPLACEMENTS
       ========================== */

    const visible = new Set(
        filtered.map(e => `${e.A}-${e.T}-${e.N}-${e.POS}`)
    );

    ALLEES.forEach((A, idxA) => {
        const row = ALLEES.length - idxA - 1;

        for (let T = 1; T <= 16; T++) {
            const maxLevel = NIV[A][T];
            const levels = getLevelsUpTo(maxLevel);

            levels.forEach((N, idxN) => {
                const baseY =
                    row * ALLEE_GAP +
                    (levels.length - idxN - 1) * LEVEL_HEIGHT;

                for (let POS = 1; POS <= 4; POS++) {
                    const key = `${A}-${T}-${N}-${POS}`;
                    if (!visible.has(key)) continue;

                    const baseX =
                        (T - 1) * TRAVE_WIDTH +
                        (POS - 1) * POS_WIDTH;

                    ctx.fillStyle = isLevelOccupied(A, T, N, POS)
                        ? "#2ecc71"
                        : "#e74c3c";

                    ctx.fillRect(
                        baseX,
                        baseY,
                        POS_WIDTH - 2,
                        LEVEL_HEIGHT - 2
                    );

                    ctx.strokeStyle = "#22222222";
                    ctx.strokeRect(
                        baseX,
                        baseY,
                        POS_WIDTH - 2,
                        LEVEL_HEIGHT - 2
                    );
                }
            });
        }
    });

    ctx.restore();
}

/* ============================================================
   BLOC 8/10 — Tooltip + Highlight
============================================================ */

/* -----------------------------
   Hover PLAN → Tooltip + Table
----------------------------- */
function detectHover(mx, my) {

    if (!ctx) return;

    const px = (mx - offsetX) / zoom;
    const py = (my - offsetY) / zoom;

    const TRAVE_WIDTH  = 120;
    const POS_WIDTH    = TRAVE_WIDTH / 4;
    const ALLEE_GAP    = 260;
    const LEVEL_HEIGHT = 18;

    let found = null;

    for (const e of filtered) {

        const row = ALLEES.length - ALLEES.indexOf(e.A) - 1;

        const levels = getLevelsUpTo(NIV[e.A][e.T]);
        const idxN = levels.indexOf(e.N);
        if (idxN === -1) continue;

        const x = (e.T - 1) * TRAVE_WIDTH + (e.POS - 1) * POS_WIDTH;
        const y = row * ALLEE_GAP + (levels.length - idxN - 1) * LEVEL_HEIGHT;

        if (px >= x && px <= x + POS_WIDTH &&
            py >= y && py <= y + LEVEL_HEIGHT) {
            found = e;
            break;
        }
    }

    if (!found) {
        tooltip.style.display = "none";
        removeRowHighlight();
        return;
    }

    tooltip.style.left = (mx + 12) + "px";
    tooltip.style.top  = (my + 12) + "px";
    tooltip.style.display = "block";

    tooltip.innerHTML = `
        <b>${found.id}</b><br>
        Allée : ${found.A}<br>
        Travée : ${found.T}<br>
        Niveau : ${found.N}<br>
        Pos : ${found.POS}<br>
        Stock : ${found.qty}
    `;

    highlightRowInTable(found.id);
}

/* -----------------------------
   Highlight TABLE
----------------------------- */
function highlightRowInTable(id){
    removeRowHighlight();
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.classList.add("highlighted-row");
}

function removeRowHighlight(){
    document.querySelectorAll(".highlighted-row")
        .forEach(el => el.classList.remove("highlighted-row"));
}

/* -----------------------------
   Highlight PLAN ← Table
----------------------------- */
function highlightInPlan(e){

    drawPlan();

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(zoom, zoom);

    const TRAVE_WIDTH  = 120;
    const POS_WIDTH    = TRAVE_WIDTH / 4;
    const ALLEE_GAP    = 260;
    const LEVEL_HEIGHT = 18;

    const row = ALLEES.length - ALLEES.indexOf(e.A) - 1;
    const levels = getLevelsUpTo(NIV[e.A][e.T]);
    const idxN = levels.indexOf(e.N);
    if (idxN === -1) return;

    const x = (e.T - 1) * TRAVE_WIDTH + (e.POS - 1) * POS_WIDTH;
    const y = row * ALLEE_GAP + (levels.length - idxN - 1) * LEVEL_HEIGHT;

    ctx.strokeStyle = "#ffcc00";
    ctx.lineWidth   = 3;
    ctx.strokeRect(x, y, POS_WIDTH - 2, LEVEL_HEIGHT - 2);

    ctx.restore();
}

/* -----------------------------
   Reset highlight
----------------------------- */
function clearPlanHighlight(){
    drawPlan();
}
/* ============================================================
   BLOC 9/10 — Mini‑map + Setup Canvas
============================================================ */

/* -----------------------------
   Mini-map
----------------------------- */
function drawMiniMap() {

    if (!minimapCtx) return;

    const W = minimap.width  = minimap.clientWidth;
    const H = minimap.height = minimap.clientHeight;

    minimapCtx.clearRect(0,0,W,H);

    const TRAVE_WIDTH  = 120;
    const POS_WIDTH    = TRAVE_WIDTH / 4;
    const ALLEE_GAP    = 260;
    const LEVEL_HEIGHT = 18;

    const scaleX = W / (16 * TRAVE_WIDTH);
    const scaleY = H / (ALLEES.length * ALLEE_GAP);
    const scale  = Math.min(scaleX, scaleY);

    filtered.forEach(e => {

        const row = ALLEES.length - ALLEES.indexOf(e.A) - 1;
        const levels = getLevelsUpTo(NIV[e.A][e.T]);
        const idxN = levels.indexOf(e.N);
        if (idxN === -1) return;

        const x = ((e.T - 1) * TRAVE_WIDTH + (e.POS - 1) * POS_WIDTH) * scale;
        const y = (row * ALLEE_GAP + (levels.length - idxN - 1) * LEVEL_HEIGHT) * scale;

        minimapCtx.fillStyle =
            e.status === "vide"   ? "#d32f2f" :
            e.status === "faible" ? "#f57c00" :
            e.status === "moyen"  ? "#f2c200" :
                                    "#2e7d32";

        minimapCtx.fillRect(
            x,
            y,
            (POS_WIDTH - 2) * scale,
            (LEVEL_HEIGHT - 2) * scale
        );
    });
}

/* -----------------------------
   Setup Canvas principal
----------------------------- */
function setupCanvas() {

    canvas  = document.getElementById("plan2d");
    ctx     = canvas.getContext("2d");

    minimap    = document.getElementById("minimap");
    minimapCtx = minimap ? minimap.getContext("2d") : null;

    tooltip = document.getElementById("tooltip");

    resizeCanvas();

    /* Zoom souris */
    canvas.addEventListener("wheel", e => {
        e.preventDefault();

        const zoomAmount = 1 - e.deltaY * 0.0012;
        const mx = (e.offsetX - offsetX) / zoom;
        const my = (e.offsetY - offsetY) / zoom;

        zoom *= zoomAmount;
        zoom = Math.max(0.25, Math.min(zoom, 3.5));

        offsetX = e.offsetX - mx * zoom;
        offsetY = e.offsetY - my * zoom;

        drawPlan();
        drawMiniMap();
    }, { passive:false });

    /* Drag */
    canvas.addEventListener("mousedown", e => {
        dragging = true;
        dragStartX = e.clientX - offsetX;
        dragStartY = e.clientY - offsetY;
        canvas.style.cursor = "grabbing";
    });

    canvas.addEventListener("mouseup", () => {
        dragging = false;
        canvas.style.cursor = "grab";
    });

    canvas.addEventListener("mousemove", e => {
        if (dragging) {
            offsetX = e.clientX - dragStartX;
            offsetY = e.clientY - dragStartY;
            drawPlan();
            drawMiniMap();
            return;
        }
        detectHover(e.offsetX, e.offsetY);
    });

    window.addEventListener("resize", () => {
        resizeCanvas();
        drawPlan();
        drawMiniMap();
    });
}

/* -----------------------------
   Resize Canvas
----------------------------- */
function resizeCanvas() {
    canvas.width  = 3000;
    canvas.height = 2000;
    canvas.style.width  = "100%";
    canvas.style.height = "100%";
}

/* -----------------------------
   Center on (table → plan)
----------------------------- */
function centerOn(e) {

    const TRAVE_WIDTH = 120;
    const POS_WIDTH   = TRAVE_WIDTH / 4;
    const ALLEE_GAP   = 260;

    const row = ALLEES.length - ALLEES.indexOf(e.A) - 1;

    const x = (e.T - 1) * TRAVE_WIDTH + (e.POS - 1) * POS_WIDTH;
    const y = row * ALLEE_GAP;

    offsetX = canvas.width  / 2 - x * zoom;
    offsetY = canvas.height / 2 - y * zoom;

    drawPlan();
    drawMiniMap();
}
/* ============================================================
   BLOC 10/10 — Dashboard + Switch onglets + Init
============================================================ */

/* -----------------------------
   Dashboard — Graphiques (3)
----------------------------- */
let chartStatus = null;
let chartAllee  = null;
let chartTop10  = null;
let currentChartType = "bar";

function renderDashboardCharts() {

    const dashboard = document.getElementById("dashboardView");
    if (!dashboard || !dashboard.classList.contains("active")) return;
    if (typeof Chart === "undefined") return;

    const statusCanvas = document.getElementById("chartStatus");
    const alleeCanvas  = document.getElementById("chartAllee");
    const top10Canvas  = document.getElementById("chartTop10");
    const dashboardModeEl = document.getElementById("dashboardMode");
const mode = dashboardModeEl ? dashboardModeEl.value : "locations";
    if (!statusCanvas || !alleeCanvas || !top10Canvas) return;

/* --- 1) Répartition des statuts --- */
let counts;

if (mode === "locations") {
    // ✅ Emplacements (inchangé)
    counts = {
        plein:  filtered.filter(e => e.status === "plein").length,
        moyen:  filtered.filter(e => e.status === "moyen").length,
        faible: filtered.filter(e => e.status === "faible").length,
        vide:   filtered.filter(e => e.status === "vide").length
    };
} else {
    // ✅ ARTICLES DANS les emplacements selon leur statut
    counts = {
        plein:  filtered.filter(e => e.status === "plein")
                        .flatMap(e => e.articles)
                        .reduce((t,a) => t + a.qty, 0),

        moyen:  filtered.filter(e => e.status === "moyen")
                        .flatMap(e => e.articles)
                        .reduce((t,a) => t + a.qty, 0),

        faible: filtered.filter(e => e.status === "faible")
                        .flatMap(e => e.articles)
                        .reduce((t,a) => t + a.qty, 0),

        vide:   filtered.filter(e => e.status === "vide")
                        .flatMap(e => e.articles)
                        .reduce((t,a) => t + a.qty, 0)
    };
}
    chartStatus?.destroy();
    chartStatus = new Chart(statusCanvas, {
        type: currentChartType,
        data: {
            labels: Object.keys(counts),
            datasets: [{
                label: mode === "locations" ? "Nombre d’emplacements" : "Quantité d’articles",
                data: Object.values(counts)
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true }
            }
        }
    });

function renderFamilleAnalysis() {

    const tbody = document.getElementById("familleTableBody");
    if (!tbody) return;

    const rows = computeFamilleStats()
        .sort((a, b) => b.rotationMax - a.rotationMax);

    tbody.innerHTML = "";

    rows.forEach(f => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${f.famille}</td>
            <td>${f.articlesDistincts}</td>
            <td>${f.stockTotal}</td>
            <td>${f.rotationMax}</td>
        `;
        tbody.appendChild(tr);
    });
}

    /* --- 2) Stock par allée --- */
    const byAllee = {};

if (mode === "locations") {
    // ✅ NOMBRE D’EMPLACEMENTS PAR ALLÉE
    filtered.forEach(e => {
        byAllee[e.A] = (byAllee[e.A] || 0) + 1;
    });
} else {
    // ✅ NOMBRE D’ARTICLES PAR ALLÉE
    filtered.forEach(e => {
        byAllee[e.A] = (byAllee[e.A] || 0) + e.qty;
    });
}

    chartAllee?.destroy();
    chartAllee = new Chart(alleeCanvas, {
        type: currentChartType,
        data: {
            labels: Object.keys(byAllee),
            datasets: [{
                label: mode === "locations" ? "Quantité par emplacement" : "Quantité par articles",
                data: Object.values(byAllee)
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true }
            }
        }
    });

    /* --- 3) Top 10 articles --- */
    const artMap = {};

if (mode === "locations") {
    // ✅ On compte les EMPLACEMENTS où l’article apparaît
    filtered.forEach(e => {
        e.articles.forEach(a => {
            artMap[a.article] = (artMap[a.article] || 0) + 1;
        });
    });
} else {
    // ✅ On compte les QUANTITÉS d’articles
    filtered.forEach(e => {
        e.articles.forEach(a => {
            artMap[a.article] = (artMap[a.article] || 0) + a.qty;
        });
    });
}

    const top10 = Object.entries(artMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    chartTop10?.destroy();
    chartTop10 = new Chart(top10Canvas, {
        type: currentChartType,
        data: {
            labels: top10.map(a => a[0]),
            datasets: [{
                label: "Quantité totale",
                data: top10.map(a => a[1])
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true }
            }
        }
    });

/* --- 4) Top 5 gestionnaires --- */
const gestMap = {};

if (mode === "locations") {
    // ✅ COMPTE LE NB D’EMPLACEMENTS PAR GESTIONNAIRE
    filtered.forEach(e => {
        const gests = new Set(e.articles.map(a => (a.gest || "NC").trim() || "NC"));
        gests.forEach(g => {
            gestMap[g] = (gestMap[g] || 0) + 1;
        });
    });
} else {
    // ✅ COMPTE LE NB D’ARTICLES PAR GESTIONNAIRE
    filtered.forEach(e => {
        e.articles.forEach(a => {
            let g = (a.gest || "").trim() || "NC";
            gestMap[g] = (gestMap[g] || 0) + a.qty;
        });
    });
}

const topGest = Object.entries(gestMap)
    .sort((a,b) => b[1] - a[1])
    .slice(0,5);

const gestCanvas = document.getElementById("chartGest");

if (gestCanvas) {

    if (window.chartGest instanceof Chart) {
        window.chartGest.destroy();
    }

    window.chartGest = new Chart(gestCanvas, {
        type: currentChartType,
        data: {
            labels: topGest.map(x => x[0]),
            datasets: [{
                label: "Qté totale",
                data: topGest.map(x => x[1]),
                backgroundColor: [
                    "#1976d2","#1e88e5","#42a5f5","#64b5f6","#90caf9"
                ]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false
        }
    });
}
}
/* -----------------------------
   Switch Onglets (version saine)
----------------------------- */

const btnTable = document.getElementById("btnTable");
const btnPlan = document.getElementById("btnPlan");
const btnDashboard = document.getElementById("btnDashboard");
const btnFamille = document.getElementById("btnFamille");

const familleView = document.getElementById("familleView");

if (btnTable) {
    btnTable.addEventListener("click", () => {
        tableView.classList.add("active");
        planView.classList.remove("active");
        dashboardView.classList.remove("active");
        familleView.classList.remove("active");
    });
}

if (btnPlan) {
    btnPlan.addEventListener("click", () => {
        planView.classList.add("active");
        tableView.classList.remove("active");
        dashboardView.classList.remove("active");
        familleView.classList.remove("active");

        drawPlan();
        drawMiniMap();
    });
}

if (btnDashboard) {
    btnDashboard.addEventListener("click", () => {
        dashboardView.classList.add("active");
        tableView.classList.remove("active");
        planView.classList.remove("active");
        familleView.classList.remove("active");

        setTimeout(() => {
            renderDashboardKPI();
            renderDashboardCharts();
            renderTopRotations();
            renderTopDormantList();
        }, 50);
    });
}

if (btnFamille) {
    btnFamille.addEventListener("click", () => {
        familleView.classList.add("active");
        tableView.classList.remove("active");
        planView.classList.remove("active");
        dashboardView.classList.remove("active");

        renderFamilleAnalysis();
    });
}

/* -----------------------------
   Refresh global sécurisé
----------------------------- */
function refresh() {
    if (!dataset.length) return;

    applyFilters();
    renderTable();
    drawPlan();
    drawMiniMap();
    updateIndicators();
    renderDashboardKPI();   

    if (dashboardView.classList.contains("active")) {
        renderDashboardCharts();
    }
}

/* ----------------
Init application
------------------ */
document.addEventListener("DOMContentLoaded", () => {

    // ===== Sélecteur Dashboard Mode =====
    const dashboardModeEl = document.getElementById("dashboardMode");
    if (dashboardModeEl) {
        dashboardModeEl.addEventListener("change", () => {
            renderDashboardCharts();
        });
    }

    // ===== Initialisation générale =====
    setupCanvas();
    populatePosFilter();
    refresh();

    // ===== Filtres à cocher =====
    const toolbarFilters = document.getElementById("toolbarFilters");
    if (toolbarFilters) {
        toolbarFilters.addEventListener("change", e => {
            if (e.target.matches("input[type='checkbox']")) {
                refresh();
            }
        });
    }

    // ===== Recherche texte =====
    if (filterText) {
        filterText.addEventListener("input", () => {
            refresh();
        });
    }

    // ===== Ouverture / fermeture des groupes de filtres =====
    document.addEventListener("click", e => {
        const title = e.target.closest(".filter-title");
        const group = e.target.closest(".filter-group");

        if (title && group) {
            document.querySelectorAll(".filter-group.open")
                .forEach(g => g !== group && g.classList.remove("open"));

            group.classList.toggle("open");
        }
    }, true);

});

