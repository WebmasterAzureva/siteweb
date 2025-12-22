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

// 🆕 V15.12 : 3 tailles optimisées (420/860/1920)
const DEFAULT_SIZES = {
    mobile: 420,      // Petites images, vignettes
    tablet: 860,      // Images moyennes, mobile Retina
    desktop: 1920     // Full width, tablet Retina
};

// 🆕 V15.12 : Cibles de poids
const TARGET_WEIGHTS = {
    mobile:  { min: 20,  max: 50,  target: 40 },    // 420px < 50 Ko
    tablet:  { min: 50,  max: 100, target: 80 },    // 860px < 100 Ko
    desktop: { min: 100, max: 250, target: 180 }    // 1920px < 250 Ko
};

// Qualités de départ
const DEFAULT_QUALITIES = {
    mobile: 60,
    tablet: 55,
    desktop: 50
};

// ==============================================================================
// 🆕 V15.5 : GÉNÉRATION AVIF AVEC CIBLAGE AUTOMATIQUE DU POIDS
// ==============================================================================
async function generateAvifWithTargetWeight(inputBuffer, width, sizeName, initialQuality, targetWeight) {
    const { min, max, target } = targetWeight;
    
    let quality = initialQuality;
    let bestBuffer = null;
    let bestQuality = quality;
    let attempts = 0;
    const maxAttempts = 4;
    
    // 🆕 V15.9 : Resize basé sur la plus grande dimension (pour images portrait)
    const resizeOptions = { 
        width, 
        height: width, 
        fit: 'inside', 
        withoutEnlargement: true 
    };
    
    // Première génération
    let buffer = await sharp(inputBuffer)
        .resize(resizeOptions)
        .avif({ quality, effort: 4 })
        .toBuffer();
    
    let sizeKo = buffer.length / 1024;
    bestBuffer = buffer;
    bestQuality = quality;
    attempts++;
    
    // Si déjà dans la fourchette, on a fini
    if (sizeKo >= min && sizeKo <= max) {
        return { buffer, quality, sizeKo, attempts, status: 'OK' };
    }
    
    // Sinon, on ajuste
    while (attempts < maxAttempts) {
        if (sizeKo > max) {
            // Trop lourd → réduire la qualité
            const ratio = target / sizeKo;
            quality = Math.max(20, Math.round(quality * Math.sqrt(ratio)));
        } else if (sizeKo < min) {
            // Trop léger → augmenter la qualité (mais pas trop, c'est OK d'être léger)
            const ratio = target / sizeKo;
            quality = Math.min(85, Math.round(quality * Math.sqrt(ratio)));
        }
        
        // Éviter de refaire la même qualité
        if (quality === bestQuality) break;
        
        buffer = await sharp(inputBuffer)
            .resize(resizeOptions)
            .avif({ quality, effort: 4 })
            .toBuffer();
        
        sizeKo = buffer.length / 1024;
        attempts++;
        
        // Garder le meilleur résultat (le plus proche de la fourchette)
        if (sizeKo >= min && sizeKo <= max) {
            return { buffer, quality, sizeKo, attempts, status: 'OK' };
        }
        
        // Si on est plus proche de la cible, garder ce résultat
        const currentDistance = Math.abs(sizeKo - target);
        const bestDistance = Math.abs(bestBuffer.length / 1024 - target);
        if (currentDistance < bestDistance) {
            bestBuffer = buffer;
            bestQuality = quality;
        }
    }
    
    // Retourner le meilleur résultat trouvé
    const finalSizeKo = bestBuffer.length / 1024;
    const status = finalSizeKo > max ? 'HEAVY' : (finalSizeKo < min ? 'LIGHT' : 'OK');
    return { buffer: bestBuffer, quality: bestQuality, sizeKo: finalSizeKo, attempts, status };
}

// ==============================================================================
// 🧠 DÉTECTION INTELLIGENTE DE LA QUALITÉ SOURCE (gardé pour les logs)
// ==============================================================================
function analyzeSourceQuality(fileSize, width, height) {
    const pixels = width * height;
    const bytesPerPixel = fileSize / pixels;
    
    let qualityLevel = '';
    
    if (bytesPerPixel >= 0.5) {
        qualityLevel = '🟢 Excellente';
    } else if (bytesPerPixel >= 0.2) {
        qualityLevel = '🟢 Bonne';
    } else if (bytesPerPixel >= 0.1) {
        qualityLevel = '🟡 Moyenne';
    } else if (bytesPerPixel >= 0.05) {
        qualityLevel = '🟠 Faible';
    } else {
        qualityLevel = '🔴 Très faible';
    }
    
    return {
        pixels,
        bytesPerPixel: bytesPerPixel.toFixed(3),
        qualityLevel
    };
}

app.get('/', (req, res) => {
    const mem = process.memoryUsage();
    res.send(`🏭 Usine V15.9 - RAM: ${Math.round(mem.heapUsed / 1024 / 1024)} Mo | Requêtes: ${requestCount}`);
});

// Route de monitoring détaillé
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        version: '15.9',
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
    { name: 'skipGemini', maxCount: 1 },
    { name: 'autoWeight', maxCount: 1 }  // 🆕 V15.5 : Mode ciblage auto du poids
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
        
        // 🆕 V15.4 : Pré-compression en JPEG (pas PNG !) si > 5000px
        const preInfo = await sharp(inputBuffer).metadata();
        
        if (preInfo.width > MAX_INPUT_SIZE || preInfo.height > MAX_INPUT_SIZE) {
            console.log(`   ⚠️ Image très grande (${preInfo.width}x${preInfo.height}), redimensionnement...`);
            
            const preCompressed = await sharp(inputBuffer)
                .resize({ 
                    width: MAX_INPUT_SIZE, 
                    height: MAX_INPUT_SIZE, 
                    fit: 'inside',
                    withoutEnlargement: true 
                })
                .jpeg({ quality: 92 })  // 🆕 JPEG au lieu de PNG !
                .toBuffer();
            
            console.log(`   ✅ Réduit : ${(imageFile.size / 1024).toFixed(0)} Ko → ${(preCompressed.length / 1024).toFixed(0)} Ko (${preInfo.width}x${preInfo.height} → max ${MAX_INPUT_SIZE}px)`);
            
            inputBuffer = null;
            inputBuffer = preCompressed;
        }
        
        // 3. ANALYSER L'IMAGE SOURCE
        const imageInfo = await sharp(inputBuffer).metadata();
        const analysis = analyzeSourceQuality(imageFile.size, imageInfo.width, imageInfo.height);
        
        console.log(`   Dimensions : ${imageInfo.width} x ${imageInfo.height} (${(analysis.pixels / 1000000).toFixed(1)} Mpx)`);
        console.log(`   Ratio : ${analysis.bytesPerPixel} octets/pixel`);
        console.log(`   Qualité source : ${analysis.qualityLevel}`);
        
        // 4. RÉCUPÉRER LES QUALITÉS DE BASE (depuis WordPress ou défaut)
        let baseQualities = { ...DEFAULT_QUALITIES };
        
        if (req.body && req.body.qualities) {
            try {
                const customQualities = JSON.parse(req.body.qualities);
                baseQualities = {
                    mobile: parseInt(customQualities.mobile) || DEFAULT_QUALITIES.mobile,
                    tablet: parseInt(customQualities.tablet) || DEFAULT_QUALITIES.tablet,
                    desktop: parseInt(customQualities.desktop) || DEFAULT_QUALITIES.desktop,
                    hd: parseInt(customQualities.hd) || DEFAULT_QUALITIES.hd,
                    fullhd: parseInt(customQualities.fullhd) || DEFAULT_QUALITIES.fullhd
                };
            } catch (e) {
                console.log(`   ⚠️ Qualités invalides, utilisation des défauts`);
            }
        }
        
        // 5. QUALITÉS FINALES (mode AUTO ajuste automatiquement, sinon on prend les valeurs définies)
        const finalQualities = { ...baseQualities };
        
        console.log(`\n🎚️ Qualités AVIF (départ) :`);
        console.log(`   mobile:  ${finalQualities.mobile} (${DEFAULT_SIZES.mobile}px)`);
        console.log(`   tablet:  ${finalQualities.tablet} (${DEFAULT_SIZES.tablet}px)`);
        console.log(`   desktop: ${finalQualities.desktop} (${DEFAULT_SIZES.desktop}px)`);

        // --- TÂCHE A : CONVERSION AVIF ---
        // 🆕 V14.1 : Traitement séquentiel pour économiser la RAM
        
        // Vérifier le mode "taille originale uniquement"
        const originalOnly = req.body && req.body.originalOnly === '1';
        
        let sizes = [];
        
        if (originalOnly) {
            // Mode "taille originale uniquement" : une seule image à la taille source
            const quality = finalQualities.original || finalQualities.retina || 50;
            sizes = [{ name: 'original', width: imageInfo.width, quality }];
            console.log(`\n📷 Mode ORIGINAL ONLY : ${imageInfo.width}px @ Q${quality}`);
        } else {
            // 🆕 V15.6 : Tailles Retina-ready par défaut
            let configuredSizes = { ...DEFAULT_SIZES };
            
            // Récupérer les tailles envoyées par WordPress
            if (req.body && req.body.sizes) {
                try {
                    const customSizes = JSON.parse(req.body.sizes);
                    configuredSizes = {};
                    for (const [name, width] of Object.entries(customSizes)) {
                        if (name !== 'original') {
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
                quality: finalQualities[name] || 50
            })).sort((a, b) => a.width - b.width);
            
            // 🆕 V15.9 : Se baser sur la plus grande dimension (pour les images portrait)
            const maxDimension = Math.max(imageInfo.width, imageInfo.height);
            const isPortrait = imageInfo.height > imageInfo.width;
            
            if (isPortrait) {
                console.log(`   📐 Image portrait détectée (${imageInfo.width}×${imageInfo.height})`);
            }
            
            // Filtrer : garder seulement les tailles ≤ plus grande dimension
            sizes = allSizes.filter(s => s.width <= maxDimension);
            
            // Si l'image est plus petite que la plus petite taille, générer quand même une version
            if (sizes.length === 0 && allSizes.length > 0) {
                const smallest = allSizes[0];
                sizes.push({ name: smallest.name, width: maxDimension, quality: smallest.quality });
            }
            
            // 🆕 V15.10 : Supprimé la taille "original" qui polluait le srcset
            // Les 5 tailles standard (350/700/1400/1920/2560) suffisent pour couvrir tous les cas
        }

        console.log(`\n📦 Génération AVIF (${sizes.length} taille${sizes.length > 1 ? 's' : ''}) :`);

        // 🆕 V15.5 : Mode automatique de ciblage du poids
        const autoWeight = req.body && req.body.autoWeight === '1';
        
        if (autoWeight) {
            console.log(`   🎯 Mode AUTO : ciblage poids optimal`);
        }

        const imageResults = [];
        let totalAvifSize = 0;
        
        for (const size of sizes) {
            try {
                let buffer, finalQuality, sizeKo, status, attempts;
                
                if (autoWeight && TARGET_WEIGHTS[size.name]) {
                    // 🆕 Mode AUTO : cibler le poids idéal
                    const result = await generateAvifWithTargetWeight(
                        inputBuffer, 
                        size.width, 
                        size.name, 
                        size.quality, 
                        TARGET_WEIGHTS[size.name]
                    );
                    
                    buffer = result.buffer;
                    finalQuality = result.quality;
                    sizeKo = result.sizeKo;
                    status = result.status;
                    attempts = result.attempts;
                    
                    const target = TARGET_WEIGHTS[size.name];
                    const statusIcon = status === 'OK' ? '✅' : (status === 'HEAVY' ? '⚠️' : '💡');
                    console.log(`   ${size.name}: ${size.width}px → ${sizeKo.toFixed(0)} Ko (Q${finalQuality}) ${statusIcon} [${target.min}-${target.max}Ko] (${attempts} essai${attempts > 1 ? 's' : ''})`);
                    
                } else {
                    // Mode classique : qualité fixe
                    const sharpInstance = sharp(inputBuffer, { limitInputPixels: false });
                    
                    // 🆕 V15.9 : Resize basé sur la plus grande dimension (pour images portrait)
                    buffer = await sharpInstance
                        .resize({ 
                            width: size.width, 
                            height: size.width, 
                            fit: 'inside',
                            withoutEnlargement: true 
                        })
                        .avif({ quality: size.quality, effort: 4 })
                        .toBuffer();
                    
                    sizeKo = buffer.length / 1024;
                    finalQuality = size.quality;
                    console.log(`   ${size.name}: ${size.width}px @ Q${size.quality} → ${sizeKo.toFixed(0)} Ko`);
                    
                    sharpInstance.destroy();
                }
                
                totalAvifSize += buffer.length;
                imageResults.push({ type: 'image', size: size.name, data: buffer.toString('base64') });
                
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
        const avgSize = generatedCount > 0 ? totalAvifSize / generatedCount : 0;
        const reduction = ((1 - totalAvifSize / imageFile.size) * 100).toFixed(0);
        
        console.log(`\n✅ Terminé !`);
        console.log(`   ${generatedCount} AVIF générés`);
        console.log(`   Poids total : ${(totalAvifSize / 1024).toFixed(0)} Ko`);
        console.log(`   Réduction vs original : ${reduction}%`);
        
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
app.listen(PORT, () => console.log(`🏭 Usine V15.9 démarrée sur le port ${PORT}`));
