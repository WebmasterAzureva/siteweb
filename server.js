const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// 🆕 V15.3 : Configuration Sharp optimisée pour 2 Go RAM
sharp.cache(false);  // Désactiver le cache (évite accumulation)
sharp.concurrency(2);  // 🆕 2 opérations en parallèle (au lieu de 1)
sharp.simd(true);  // SIMD pour la performance

const app = express();

// 🆕 V15.3 : Limite fichier augmentée à 50 Mo
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 50 * 1024 * 1024 }  // 50 Mo max
});

// Variables d'environnement
const API_KEY_GEMINI = process.env.GEMINI_API_KEY; 
const SECRET_TOKEN = process.env.MY_SECRET_TOKEN;

// Compteur de requêtes pour monitoring mémoire
let requestCount = 0;

// 🆕 V15.3 : Taille max avant pré-compression (plus souple avec 2 Go)
const MAX_INPUT_SIZE = 5000;  // 5000px au lieu de 3000px

// QUALITÉS PAR DÉFAUT
const DEFAULT_QUALITIES = {
    mobile: 70,
    tablet: 65,
    desktop: 60,
    large: 55
};

// ==============================================================================
// 🧠 DÉTECTION INTELLIGENTE DE LA QUALITÉ SOURCE
// ==============================================================================
function analyzeSourceQuality(fileSize, width, height) {
    const pixels = width * height;
    const bytesPerPixel = fileSize / pixels;
    
    let qualityBonus = 0;
    let qualityLevel = '';
    
    if (bytesPerPixel >= 0.5) {
        qualityLevel = '🟢 Excellente';
        qualityBonus = 0;
    } else if (bytesPerPixel >= 0.2) {
        qualityLevel = '🟢 Bonne';
        qualityBonus = 0;
    } else if (bytesPerPixel >= 0.1) {
        qualityLevel = '🟡 Moyenne';
        qualityBonus = 10;
    } else if (bytesPerPixel >= 0.05) {
        qualityLevel = '🟠 Faible';
        qualityBonus = 15;
    } else {
        qualityLevel = '🔴 Très faible';
        qualityBonus = 20;
    }
    
    return {
        pixels,
        bytesPerPixel: bytesPerPixel.toFixed(3),
        qualityLevel,
        qualityBonus
    };
}

// Applique le bonus sans dépasser 95
function applyQualityBonus(baseQuality, bonus) {
    return Math.min(95, baseQuality + bonus);
}

app.get('/', (req, res) => {
    const mem = process.memoryUsage();
    res.send(`🏭 Usine V15.3 (2 Go) - RAM: ${Math.round(mem.heapUsed / 1024 / 1024)} Mo | Requêtes: ${requestCount}`);
});

// Route de monitoring détaillé
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        version: '15.3',
        plan: 'Standard 2GB',
        status: 'ok',
        requests: requestCount,
        memory: {
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
            rss: Math.round(mem.rss / 1024 / 1024),
            external: Math.round(mem.external / 1024 / 1024)
        },
        uptime: Math.round(process.uptime())
    });
});

// Route principale
app.post('/process', (req, res, next) => {
    console.log("\n📨 REQUÊTE REÇUE !");
    next();
}, upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'qualities', maxCount: 1 },
    { name: 'sizes', maxCount: 1 },
    { name: 'originalOnly', maxCount: 1 },
    { name: 'skipGemini', maxCount: 1 }  // 🆕 Option pour skip le SEO
]), async (req, res) => {
    
    // 1. SÉCURITÉ
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
        console.error("⛔ Refusé : Mauvais token.");
        return res.status(403).json({ error: 'Accès refusé.' });
    }

    // 2. VÉRIFICATION FICHIER
    if (!req.files || !req.files.image || !req.files.image[0]) {
        console.error("⛔ Refusé : Pas de fichier image.");
        return res.status(400).json({ error: 'Pas de fichier image.' });
    }

    try {
        // 🆕 V14.3 : Monitoring mémoire
        requestCount++;
        const memBefore = process.memoryUsage();
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📊 Requête #${requestCount} | RAM: ${Math.round(memBefore.heapUsed / 1024 / 1024)} Mo / ${Math.round(memBefore.heapTotal / 1024 / 1024)} Mo`);
        
        const imageFile = req.files.image[0];
        let inputBuffer = imageFile.buffer;
        
        console.log(`📁 Image : ${imageFile.originalname}`);
        console.log(`   Poids original : ${(imageFile.size / 1024).toFixed(1)} Ko`);
        
        // 🆕 V15.3 : Pré-compression uniquement si > 5000px (2 Go RAM permet plus)
        const preInfo = await sharp(inputBuffer).metadata();
        
        if (preInfo.width > MAX_INPUT_SIZE || preInfo.height > MAX_INPUT_SIZE) {
            console.log(`   ⚠️ Image très grande (${preInfo.width}x${preInfo.height}), pré-compression...`);
            
            const preCompressed = await sharp(inputBuffer)
                .resize({ 
                    width: MAX_INPUT_SIZE, 
                    height: MAX_INPUT_SIZE, 
                    fit: 'inside',
                    withoutEnlargement: true 
                })
                .png({ quality: 95, compressionLevel: 1 })
                .toBuffer();
            
            inputBuffer = null;
            inputBuffer = preCompressed;
            
            console.log(`   ✅ Réduit à ${(preCompressed.length / 1024).toFixed(1)} Ko`);
        }
        
        // 3. ANALYSER L'IMAGE SOURCE
        const imageInfo = await sharp(inputBuffer).metadata();
        const analysis = analyzeSourceQuality(imageFile.size, imageInfo.width, imageInfo.height);
        
        console.log(`   Dimensions : ${imageInfo.width} x ${imageInfo.height} (${(analysis.pixels / 1000000).toFixed(1)} Mpx)`);
        console.log(`   Ratio : ${analysis.bytesPerPixel} octets/pixel`);
        console.log(`   Qualité source : ${analysis.qualityLevel}`);
        
        if (analysis.qualityBonus > 0) {
            console.log(`   🧠 Compensation : +${analysis.qualityBonus} qualité AVIF`);
        }
        
        // 4. RÉCUPÉRER LES QUALITÉS DE BASE (depuis WordPress ou défaut)
        let baseQualities = { ...DEFAULT_QUALITIES };
        
        if (req.body && req.body.qualities) {
            try {
                const customQualities = JSON.parse(req.body.qualities);
                baseQualities = {
                    mobile: parseInt(customQualities.mobile) || DEFAULT_QUALITIES.mobile,
                    tablet: parseInt(customQualities.tablet) || DEFAULT_QUALITIES.tablet,
                    desktop: parseInt(customQualities.desktop) || DEFAULT_QUALITIES.desktop,
                    large: parseInt(customQualities.large) || DEFAULT_QUALITIES.large
                };
            } catch (e) {
                console.log(`   ⚠️ Qualités invalides, utilisation des défauts`);
            }
        }
        
        // 5. APPLIQUER LE BONUS DE QUALITÉ
        const finalQualities = {
            mobile: applyQualityBonus(baseQualities.mobile, analysis.qualityBonus),
            tablet: applyQualityBonus(baseQualities.tablet, analysis.qualityBonus),
            desktop: applyQualityBonus(baseQualities.desktop, analysis.qualityBonus),
            large: applyQualityBonus(baseQualities.large, analysis.qualityBonus)
        };
        
        console.log(`\n🎚️ Qualités AVIF :`);
        console.log(`   mobile:  ${finalQualities.mobile} (480px)`);
        console.log(`   tablet:  ${finalQualities.tablet} (768px)`);
        console.log(`   desktop: ${finalQualities.desktop} (1280px)`);
        console.log(`   large:   ${finalQualities.large} (1920px)`);

        // --- TÂCHE A : CONVERSION AVIF ---
        // 🆕 V14.1 : Traitement séquentiel pour économiser la RAM
        
        // Vérifier le mode "taille originale uniquement"
        const originalOnly = req.body && req.body.originalOnly === '1';
        
        let sizes = [];
        
        if (originalOnly) {
            // 🆕 Mode "taille originale uniquement" : une seule image à la taille source
            const quality = finalQualities.original || finalQualities.large || 65;
            sizes = [{ name: 'original', width: imageInfo.width, quality }];
            console.log(`\n📷 Mode ORIGINAL ONLY : ${imageInfo.width}px @ Q${quality}`);
        } else {
            // Mode responsive : plusieurs tailles
            let configuredSizes = {
                mobile: 480,
                tablet: 768,
                desktop: 1280,
                large: 1920
            };
            
            // Récupérer les tailles envoyées par WordPress
            if (req.body && req.body.sizes) {
                try {
                    const customSizes = JSON.parse(req.body.sizes);
                    configuredSizes = {};
                    for (const [name, width] of Object.entries(customSizes)) {
                        if (name !== 'original') { // Ignorer "original" des tailles configurées
                            configuredSizes[name] = parseInt(width);
                        }
                    }
                    console.log(`📐 Tailles configurées :`, configuredSizes);
                } catch (e) {
                    console.log(`   ⚠️ Tailles invalides, utilisation des défauts`);
                }
            }
            
            // Construire la liste des tailles à générer
            const allSizes = Object.entries(configuredSizes).map(([name, width]) => ({
                name,
                width,
                quality: finalQualities[name] || 60
            })).sort((a, b) => a.width - b.width);
            
            // Filtrer : garder seulement les tailles ≤ largeur originale
            sizes = allSizes.filter(s => s.width <= imageInfo.width);
            
            // Si l'image est plus petite que la plus petite taille, générer quand même une version
            if (sizes.length === 0 && allSizes.length > 0) {
                const smallest = allSizes[0];
                sizes.push({ name: smallest.name, width: imageInfo.width, quality: smallest.quality });
            }
            
            // Ajouter une taille "originale" si l'image ne correspond à aucun breakpoint exact
            const maxFilteredWidth = sizes.length > 0 ? Math.max(...sizes.map(s => s.width)) : 0;
            const maxConfiguredWidth = Object.values(configuredSizes).length > 0 ? Math.max(...Object.values(configuredSizes)) : 1920;
            if (imageInfo.width > maxFilteredWidth && imageInfo.width < maxConfiguredWidth) {
                sizes.push({ name: 'original', width: imageInfo.width, quality: finalQualities.large || 55 });
            }
        }

        console.log(`\n📦 Génération AVIF (${sizes.length} taille${sizes.length > 1 ? 's' : ''}) :`);

        // 🆕 V14.2 : Traitement SÉQUENTIEL avec nettoyage agressif
        const imageResults = [];
        for (const size of sizes) {
            try {
                // Créer une nouvelle instance Sharp pour chaque taille
                const sharpInstance = sharp(inputBuffer, { limitInputPixels: false });
                
                const buffer = await sharpInstance
                    .resize({ width: size.width, withoutEnlargement: true })
                    .toFormat('avif', { 
                        quality: size.quality, 
                        effort: 3
                    })
                    .toBuffer();
                
                const sizeKo = (buffer.length / 1024).toFixed(1);
                console.log(`   ${size.name}: ${size.width}px @ Q${size.quality} → ${sizeKo} Ko`);
                
                // Stocker le résultat
                imageResults.push({ type: 'image', size: size.name, data: buffer.toString('base64') });
                
                // 🧹 Nettoyage explicite
                sharpInstance.destroy();  // Détruire l'instance Sharp
                
            } catch (err) {
                console.error(`   ❌ Erreur ${size.name}:`, err.message);
            }
        }

        // --- TÂCHE B : IA GEMINI (optionnel) ---
        const skipGemini = req.body && req.body.skipGemini === '1';
        let seoResult = null;
        
        if (API_KEY_GEMINI && !skipGemini) {
            try {
                const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
                const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
                
                const compressedBuffer = await sharp(inputBuffer)
                    .resize({ width: 800, withoutEnlargement: true })
                    .jpeg({ quality: 70 })
                    .toBuffer();
                
                console.log(`\n🤖 Gemini : analyse en cours...`);
                
                const prompt = "Expert SEO. Analyse cette image. Retourne UNIQUEMENT un JSON valide : { 'title': '...', 'alt': '...', 'description': '...' }. Langue : Français.";
                
                const result = await model.generateContent([
                    prompt,
                    { inlineData: { data: compressedBuffer.toString('base64'), mimeType: 'image/jpeg' } }
                ]);
                
                const text = result.response.text().replace(/```json|```/g, '').trim();
                console.log(`   ✅ Gemini OK`);
                seoResult = JSON.parse(text);
            } catch (err) {
                console.error(`   ⚠️ Gemini échoué:`, err.message);
            }
        } else if (skipGemini) {
            console.log(`\n⏭️ Gemini : ignoré (skipGemini=1)`);
        }

        // 6. RÉPONSE
        const responseData = { images: {}, seo: seoResult };
        
        imageResults.forEach(item => {
            responseData.images[item.size] = item.data;
        });

        // Stats
        const generatedCount = Object.keys(responseData.images).length;
        const totalAvifSize = Object.values(responseData.images).reduce((acc, b64) => {
            return acc + Buffer.from(b64, 'base64').length;
        }, 0);
        const avgSize = generatedCount > 0 ? totalAvifSize / generatedCount : 0;
        const reduction = ((1 - avgSize / imageFile.size) * 100).toFixed(0);
        
        console.log(`\n✅ Terminé !`);
        console.log(`   ${generatedCount} AVIF générés`);
        console.log(`   Réduction moyenne : ${reduction}%`);
        
        // 🆕 V14.2 : Nettoyage mémoire
        inputBuffer = null;  // Libérer le buffer d'entrée
        
        // Forcer le garbage collector si disponible
        if (global.gc) {
            global.gc();
            console.log(`   🧹 GC forcé`);
        }
        
        const memAfter = process.memoryUsage();
        console.log(`   📊 RAM: ${Math.round(memAfter.heapUsed / 1024 / 1024)} Mo`);
        console.log(`${'─'.repeat(50)}\n`);
        
        res.json(responseData);

    } catch (error) {
        console.error("❌ Erreur:", error.message);
        
        // Nettoyage même en cas d'erreur
        if (global.gc) global.gc();
        
        res.status(500).json({ error: error.message });
    }
});

// ==============================================================================
// 🆕 ROUTE SEO UNIQUEMENT (Gemini)
// ==============================================================================
// ==============================================================================
// 🆕 V15.2 : ROUTE SEO UNIVERSELLE - 1 SEUL APPEL GEMINI
// ==============================================================================
app.post('/seo', upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'customPrompt', maxCount: 1 },
    { name: 'brandName', maxCount: 1 },
    { name: 'brandSector', maxCount: 1 },
    { name: 'brandConditional', maxCount: 1 },
    { name: 'categories', maxCount: 1 }
]), async (req, res) => {
    console.log("\n" + "═".repeat(60));
    console.log("📨 REQUÊTE SEO (V15.2 - 1 appel)");
    console.log("═".repeat(60));
    
    try {
        // Vérification du token
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
            return res.status(401).json({ error: 'Token invalide' });
        }
        
        if (!API_KEY_GEMINI) {
            return res.status(500).json({ error: 'Clé Gemini non configurée' });
        }
        
        const imageFile = req.files?.image?.[0];
        if (!imageFile) {
            return res.status(400).json({ error: 'Aucune image reçue' });
        }
        
        console.log(`📁 Image : ${imageFile.originalname}`);
        console.log(`   Poids : ${(imageFile.size / 1024).toFixed(1)} Ko`);
        
        // Récupérer les paramètres
        const customPrompt = req.body?.customPrompt || '';
        const brandName = req.body?.brandName || '';
        const brandSector = req.body?.brandSector || '';
        const brandConditional = req.body?.brandConditional === '1';
        const categoriesRaw = req.body?.categories || '';
        
        // Parser les catégories thématiques
        const categories = [];
        if (categoriesRaw) {
            const lines = categoriesRaw.split('\n').filter(l => l.trim() && l.includes(':'));
            for (const line of lines) {
                const colonIndex = line.indexOf(':');
                let catName = line.substring(0, colonIndex).trim();
                const keywords = line.substring(colonIndex + 1).split(',').map(k => k.trim()).filter(Boolean);
                
                const isMulti = catName.endsWith('*');
                if (isMulti) {
                    catName = catName.slice(0, -1).trim();
                }
                
                if (catName && keywords.length > 0) {
                    categories.push({ name: catName, keywords, multi: isMulti });
                }
            }
        }
        
        console.log(`⚙️ Config : Marque=${brandName || '(aucune)'} | Catégories=${categories.length}`);
        
        const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        
        // Compresser l'image pour Gemini
        const compressedBuffer = await sharp(imageFile.buffer)
            .resize({ width: 800, withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();
        
        const imageData = { inlineData: { data: compressedBuffer.toString('base64'), mimeType: 'image/jpeg' } };
        
        // =================================================================
        // CONSTRUIRE LE PROMPT UNIQUE (tout en 1 seul appel)
        // =================================================================
        let prompt = `Tu es un expert SEO. Analyse cette image et génère les métadonnées optimisées.

`;
        
        // Instructions personnalisées
        if (customPrompt) {
            prompt += `INSTRUCTIONS DE STYLE : ${customPrompt}

`;
        }
        
        // Analyse de pertinence (si mode conditionnel)
        if (brandConditional && brandSector && brandName) {
            prompt += `ANALYSE DE PERTINENCE :
Le secteur d'activité est : "${brandSector}"
Détermine si cette image est liée à ce secteur (photo de produit, service, ambiance liée au secteur).
Les icônes, pictogrammes, illustrations génériques ne sont PAS pertinentes.

`;
        }
        
        // Catégories de mots-clés
        if (categories.length > 0) {
            prompt += `CATÉGORIES DE MOTS-CLÉS :
`;
            for (const cat of categories) {
                if (cat.multi) {
                    prompt += `${cat.name} (choisis TOUS les mots visibles, ou tableau vide) : ${cat.keywords.join(', ')}
`;
                } else {
                    prompt += `${cat.name} (choisis UN SEUL mot, ou null) : ${cat.keywords.join(', ')}
`;
                }
            }
            prompt += `
`;
        }
        
        // Instructions pour la marque
        if (brandName) {
            prompt += `MARQUE : "${brandName}"
`;
            if (brandConditional) {
                prompt += `Si l'image est pertinente avec le secteur :
- Ajoute "${brandName}" à la FIN du titre (ex: "Description - ${brandName}")
- Mentionne "${brandName}" UNE FOIS dans la description
- NE JAMAIS mettre la marque dans l'alt

Si l'image N'EST PAS pertinente : ne mets PAS la marque du tout.

`;
            } else {
                prompt += `Ajoute TOUJOURS "${brandName}" à la fin du titre et une fois dans la description.
NE JAMAIS mettre la marque dans l'alt.

`;
            }
        }
        
        // Format de réponse
        prompt += `RÉPONDS UNIQUEMENT avec ce JSON (pas de commentaire, pas de markdown) :
{
  "isRelevant": ${brandConditional && brandSector ? 'true ou false selon si l\'image est liée au secteur' : 'true'},
  "keywords": {
${categories.map(c => `    "${c.name}": ${c.multi ? '["mot1", "mot2"] ou []' : '"mot choisi" ou null'}`).join(',\n')}
  },
  "seo": {
    "title": "Titre accrocheur (50-60 car)${brandName ? ` + " - ${brandName}" si pertinent` : ''}",
    "alt": "Description factuelle de ce qui est VISIBLE (100-125 car, JAMAIS de marque)",
    "description": "Description engageante (150-160 car)${brandName ? ` avec ${brandName} si pertinent` : ''}"
  }
}

LANGUE : Français uniquement.`;

        console.log(`🤖 Gemini : appel unique en cours...`);
        
        const result = await model.generateContent([prompt, imageData]);
        const text = result.response.text().replace(/```json|```/g, '').trim();
        
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            console.error(`❌ Erreur parsing JSON:`, text.substring(0, 200));
            throw new Error('Réponse Gemini invalide');
        }
        
        // Extraire les résultats
        const imageIsRelevant = data.isRelevant !== false;
        const seoData = data.seo;
        const keywordsData = data.keywords || {};
        
        // Traiter les mots-clés sélectionnés
        const selectedKeywords = {};
        const keywordsList = [];
        
        for (const cat of categories) {
            const value = keywordsData[cat.name];
            if (cat.multi && Array.isArray(value) && value.length > 0) {
                // Valider que les mots sont dans la liste
                const validKeywords = value.filter(v => 
                    v && cat.keywords.some(k => k.toLowerCase() === v.toLowerCase())
                );
                if (validKeywords.length > 0) {
                    selectedKeywords[cat.name] = validKeywords;
                    keywordsList.push(...validKeywords);
                }
            } else if (!cat.multi && value && value !== 'null') {
                // Valider que le mot est dans la liste
                const match = cat.keywords.find(k => k.toLowerCase() === value.toLowerCase());
                if (match) {
                    selectedKeywords[cat.name] = match;
                    keywordsList.push(match);
                }
            }
        }
        
        // Déterminer si la marque a été appliquée
        const brandApplied = brandName && (imageIsRelevant || !brandConditional);
        
        // =================================================================
        // RÉSULTAT
        // =================================================================
        console.log(`✅ SEO GÉNÉRÉ !`);
        console.log(`   📌 Titre : ${seoData.title}`);
        console.log(`   🖼️ Alt : ${seoData.alt?.substring(0, 50)}...`);
        console.log(`   🏢 Marque : ${brandApplied ? 'Oui' : 'Non'}`);
        if (keywordsList.length > 0) {
            console.log(`   🏷️ Mots-clés : ${keywordsList.join(', ')}`);
        }
        console.log("─".repeat(60) + "\n");
        
        // Formater les catégories utilisées
        const categoriesUsed = [];
        for (const [cat, kw] of Object.entries(selectedKeywords)) {
            if (Array.isArray(kw)) {
                categoriesUsed.push(`${cat}*:${kw.join(',')}`);
            } else {
                categoriesUsed.push(`${cat}:${kw}`);
            }
        }
        
        res.json({ 
            seo: seoData,
            brandApplied: brandApplied,
            imageRelevant: imageIsRelevant,
            keywordsUsed: keywordsList,
            categoriesUsed: categoriesUsed
        });
        
    } catch (error) {
        console.error("❌ Erreur SEO:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏭 Usine V15.3 (Standard 2 Go) démarrée sur le port ${PORT}`));
