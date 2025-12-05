const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// 🆕 V14.2 : Configuration Sharp pour éviter les fuites mémoire
sharp.cache(false);  // Désactiver le cache Sharp
sharp.concurrency(1);  // Une seule opération à la fois
sharp.simd(true);  // Utiliser SIMD pour la performance

const app = express();

// Configuration de l'upload (20 Mo max)
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 20 * 1024 * 1024 } 
});

// Variables d'environnement
const API_KEY_GEMINI = process.env.GEMINI_API_KEY; 
const SECRET_TOKEN = process.env.MY_SECRET_TOKEN;

// Compteur de requêtes pour monitoring mémoire
let requestCount = 0;

// 🆕 QUALITÉS PAR DÉFAUT INVERSÉES
// Plus de qualité pour les petites tailles (artefacts plus visibles)
const DEFAULT_QUALITIES = {
    mobile: 70,   // ↑ Était 50 - petite image = qualité haute
    tablet: 65,   // ↑ Était 55
    desktop: 60,  // = Inchangé
    large: 55     // ↓ Était 70 - grande image = on peut compresser plus
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
    res.send(`🏭 Usine V15.1 - RAM: ${Math.round(mem.heapUsed / 1024 / 1024)} Mo | Requêtes: ${requestCount}`);
});

// Route de monitoring détaillé
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        version: '15.1',
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
        
        // 🆕 V14.3 : Pré-compression si image trop grande (> 3000px)
        // Ça réduit drastiquement l'usage mémoire pour les grandes images
        const MAX_INPUT_SIZE = 3000;
        const preInfo = await sharp(inputBuffer).metadata();
        
        if (preInfo.width > MAX_INPUT_SIZE || preInfo.height > MAX_INPUT_SIZE) {
            console.log(`   ⚠️ Image trop grande (${preInfo.width}x${preInfo.height}), pré-compression...`);
            
            const preCompressed = await sharp(inputBuffer)
                .resize({ 
                    width: MAX_INPUT_SIZE, 
                    height: MAX_INPUT_SIZE, 
                    fit: 'inside',
                    withoutEnlargement: true 
                })
                .png({ quality: 95, compressionLevel: 1 })  // PNG rapide, quasi sans perte
                .toBuffer();
            
            // Libérer l'ancien buffer
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
// 🆕 V15.0 : ROUTE SEO UNIVERSELLE
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
    console.log("📨 REQUÊTE SEO UNIVERSELLE");
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
        
        console.log(`\n⚙️ Configuration :`);
        if (brandName) {
            console.log(`   🏢 Marque : ${brandName}`);
            console.log(`   📋 Secteur : ${brandSector ? brandSector.substring(0, 50) + '...' : '(non défini)'}`);
            console.log(`   🎯 Application : ${brandConditional ? 'Intelligente (si pertinent)' : 'Systématique'}`);
        } else {
            console.log(`   🏢 Marque : (aucune)`);
        }
        
        // Parser les catégories thématiques
        // Format : "CATÉGORIE: mot1, mot2" (UN SEUL mot choisi)
        // Format : "CATÉGORIE*: mot1, mot2" (TOUS les mots pertinents)
        const categories = [];
        if (categoriesRaw) {
            const lines = categoriesRaw.split('\n').filter(l => l.trim() && l.includes(':'));
            for (const line of lines) {
                const colonIndex = line.indexOf(':');
                let catName = line.substring(0, colonIndex).trim();
                const keywords = line.substring(colonIndex + 1).split(',').map(k => k.trim()).filter(Boolean);
                
                // Détecter le mode multi-sélection (étoile *)
                const isMulti = catName.endsWith('*');
                if (isMulti) {
                    catName = catName.slice(0, -1).trim();  // Retirer l'étoile
                }
                
                if (catName && keywords.length > 0) {
                    categories.push({ name: catName, keywords, multi: isMulti });
                }
            }
            
            const singleCats = categories.filter(c => !c.multi).length;
            const multiCats = categories.filter(c => c.multi).length;
            console.log(`   🏷️ Catégories : ${singleCats} simple(s), ${multiCats} multi(*)`);
        }
        
        const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        
        // Compresser l'image pour Gemini
        const compressedBuffer = await sharp(imageFile.buffer)
            .resize({ width: 800, withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();
        
        const imageData = { inlineData: { data: compressedBuffer.toString('base64'), mimeType: 'image/jpeg' } };
        
        // =================================================================
        // ÉTAPE 1 : Analyse de l'image et détection de pertinence
        // =================================================================
        let imageIsRelevant = true;  // Par défaut, on considère l'image pertinente
        let imageAnalysis = null;
        
        if (brandConditional && brandSector) {
            console.log(`\n🔍 Étape 1 : Analyse de pertinence...`);
            
            const analysisPrompt = `Analyse cette image et réponds UNIQUEMENT avec un JSON valide.

SECTEUR D'ACTIVITÉ À VÉRIFIER : ${brandSector}

Questions à répondre :
1. L'image est-elle une photo/illustration liée à ce secteur d'activité ?
2. Quel est le type d'image ? (photo de produit/service, photo d'ambiance, icône/pictogramme, illustration, logo, capture d'écran, autre)

Réponds UNIQUEMENT avec ce JSON :
{
  "isRelevant": true ou false,
  "imageType": "type d'image",
  "reason": "explication courte"
}`;

            try {
                const analysisResult = await model.generateContent([analysisPrompt, imageData]);
                const analysisText = analysisResult.response.text().replace(/```json|```/g, '').trim();
                imageAnalysis = JSON.parse(analysisText);
                imageIsRelevant = imageAnalysis.isRelevant === true;
                
                console.log(`   Type : ${imageAnalysis.imageType}`);
                console.log(`   Pertinente : ${imageIsRelevant ? '✅ Oui' : '❌ Non'}`);
                if (!imageIsRelevant) {
                    console.log(`   Raison : ${imageAnalysis.reason}`);
                }
            } catch (e) {
                console.log(`   ⚠️ Analyse échouée, on considère pertinent par défaut`);
                imageIsRelevant = true;
            }
        }
        
        // =================================================================
        // ÉTAPE 2 : Sélection des mots-clés par catégorie
        // =================================================================
        const selectedKeywords = {};  // Pour les catégories simples : string
                                      // Pour les catégories multi : array
        
        if (categories.length > 0 && imageIsRelevant) {
            console.log(`\n🏷️ Étape 2 : Sélection des mots-clés...`);
            
            // Séparer les catégories simples et multi
            const singleCats = categories.filter(c => !c.multi);
            const multiCats = categories.filter(c => c.multi);
            
            // Construire le prompt pour Gemini
            let categoriesPrompt = `Analyse cette image et sélectionne les mots-clés pertinents.

`;
            
            if (singleCats.length > 0) {
                categoriesPrompt += `CATÉGORIES SIMPLES (choisis UN SEUL mot par catégorie, ou null si aucun n'est pertinent) :\n`;
                for (const cat of singleCats) {
                    categoriesPrompt += `${cat.name}: ${cat.keywords.join(', ')}\n`;
                }
                categoriesPrompt += `\n`;
            }
            
            if (multiCats.length > 0) {
                categoriesPrompt += `CATÉGORIES MULTIPLES (choisis TOUS les mots visibles/pertinents, ou tableau vide si aucun) :\n`;
                for (const cat of multiCats) {
                    categoriesPrompt += `${cat.name}: ${cat.keywords.join(', ')}\n`;
                }
                categoriesPrompt += `\n`;
            }
            
            categoriesPrompt += `Réponds UNIQUEMENT avec un JSON valide :
{
${singleCats.map(c => `  "${c.name}": "mot choisi ou null"`).join(',\n')}${singleCats.length > 0 && multiCats.length > 0 ? ',' : ''}
${multiCats.map(c => `  "${c.name}": ["mot1", "mot2"] ou []`).join(',\n')}
}

IMPORTANT : Pour les catégories multiples, retourne un TABLEAU avec tous les mots pertinents visibles dans l'image.`;

            try {
                const keywordsResult = await model.generateContent([categoriesPrompt, imageData]);
                const keywordsText = keywordsResult.response.text().replace(/```json|```/g, '').trim();
                const keywordsData = JSON.parse(keywordsText);
                
                // Traiter les catégories simples
                for (const cat of singleCats) {
                    const chosen = keywordsData[cat.name];
                    if (chosen && chosen !== 'null' && chosen !== null) {
                        const normalizedChosen = chosen.toLowerCase().trim();
                        const matchedKeyword = cat.keywords.find(k => k.toLowerCase().trim() === normalizedChosen);
                        if (matchedKeyword) {
                            selectedKeywords[cat.name] = matchedKeyword;
                            console.log(`   ${cat.name}: "${matchedKeyword}"`);
                        }
                    }
                }
                
                // Traiter les catégories multi
                for (const cat of multiCats) {
                    const chosenArray = keywordsData[cat.name];
                    if (Array.isArray(chosenArray) && chosenArray.length > 0) {
                        const matchedKeywords = [];
                        for (const chosen of chosenArray) {
                            if (chosen && chosen !== 'null' && chosen !== null) {
                                const normalizedChosen = chosen.toLowerCase().trim();
                                const matchedKeyword = cat.keywords.find(k => k.toLowerCase().trim() === normalizedChosen);
                                if (matchedKeyword && !matchedKeywords.includes(matchedKeyword)) {
                                    matchedKeywords.push(matchedKeyword);
                                }
                            }
                        }
                        if (matchedKeywords.length > 0) {
                            selectedKeywords[cat.name] = matchedKeywords;
                            console.log(`   ${cat.name}*: ${matchedKeywords.map(k => `"${k}"`).join(', ')}`);
                        }
                    }
                }
                
                if (Object.keys(selectedKeywords).length === 0) {
                    console.log(`   (aucun mot-clé sélectionné)`);
                }
            } catch (e) {
                console.log(`   ⚠️ Sélection échouée : ${e.message}`);
            }
        }
        
        // =================================================================
        // ÉTAPE 3 : Génération du SEO
        // =================================================================
        console.log(`\n✍️ Étape 3 : Génération du SEO...`);
        
        let seoPrompt = `Tu es un expert SEO. Génère les métadonnées optimisées pour cette image.

`;
        
        // Instructions personnalisées
        if (customPrompt) {
            seoPrompt += `INSTRUCTIONS DE STYLE :\n${customPrompt}\n\n`;
        }
        
        // Marque (si pertinente ou si mode systématique)
        const applyBrand = brandName && (imageIsRelevant || !brandConditional);
        
        if (applyBrand) {
            seoPrompt += `MARQUE : ${brandName}
RÈGLES POUR LA MARQUE :
- TITRE : Ajoute "${brandName}" à la FIN, séparé par " - " ou " | "
  Exemple : "Description de l'image - ${brandName}"
- ALT : NE JAMAIS inclure la marque ! L'alt décrit UNIQUEMENT ce qui est visible.
- DESCRIPTION : Mentionne "${brandName}" UNE SEULE FOIS, naturellement.

`;
        }
        
        // Mots-clés sélectionnés (aplatir les tableaux pour les catégories multi)
        const keywordsList = [];
        for (const value of Object.values(selectedKeywords)) {
            if (Array.isArray(value)) {
                keywordsList.push(...value);
            } else {
                keywordsList.push(value);
            }
        }
        
        if (keywordsList.length > 0) {
            seoPrompt += `MOTS-CLÉS À INTÉGRER (naturellement) :
${keywordsList.join(', ')}

`;
        }
        
        // Format de réponse
        seoPrompt += `FORMAT DE RÉPONSE (JSON uniquement) :
{
  "title": "Titre accrocheur${applyBrand ? ' - ' + brandName : ''} (50-60 caractères max)",
  "alt": "Description factuelle de ce qui est VISIBLE dans l'image (100-125 caractères, SANS marque)",
  "description": "Description engageante${applyBrand ? ' mentionnant ' + brandName + ' une fois' : ''} (150-160 caractères)"
}

LANGUE : Français uniquement.
IMPORTANT : Réponds UNIQUEMENT avec le JSON, sans commentaire.`;

        const seoResult = await model.generateContent([seoPrompt, imageData]);
        const seoText = seoResult.response.text().replace(/```json|```/g, '').trim();
        const seoData = JSON.parse(seoText);
        
        // =================================================================
        // RÉSULTAT
        // =================================================================
        console.log(`\n✅ SEO GÉNÉRÉ !`);
        console.log(`   📌 Titre : ${seoData.title}`);
        console.log(`   🖼️ Alt : ${seoData.alt?.substring(0, 60)}...`);
        console.log(`   📝 Desc : ${seoData.description?.substring(0, 60)}...`);
        console.log(`   🏢 Marque appliquée : ${applyBrand ? 'Oui' : 'Non'}`);
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
            brandApplied: applyBrand,
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
app.listen(PORT, () => console.log(`🏭 Usine V15.1 démarrée sur le port ${PORT}`));
