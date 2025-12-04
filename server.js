const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// Configuration de l'upload (20 Mo max)
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 20 * 1024 * 1024 } 
});

// Variables d'environnement
const API_KEY_GEMINI = process.env.GEMINI_API_KEY; 
const SECRET_TOKEN = process.env.MY_SECRET_TOKEN;

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

app.get('/', (req, res) => res.send('🏭 Usine V10 - Optimisée vitesse + qualité'));

// Route principale
app.post('/process', (req, res, next) => {
    console.log("\n📨 REQUÊTE REÇUE !");
    next();
}, upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'qualities', maxCount: 1 }
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
        const imageFile = req.files.image[0];
        const inputBuffer = imageFile.buffer;
        
        console.log(`📁 Image : ${imageFile.originalname}`);
        console.log(`   Poids : ${(imageFile.size / 1024).toFixed(1)} Ko`);
        
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

        const tasks = [];

        // --- TÂCHE A : CONVERSION AVIF ---
        // 🆕 V10 : Effort réduit pour éviter les timeouts
        const sizes = [
            { name: 'mobile', width: 480, quality: finalQualities.mobile },
            { name: 'tablet', width: 768, quality: finalQualities.tablet },
            { name: 'desktop', width: 1280, quality: finalQualities.desktop },
            { name: 'large', width: 1920, quality: finalQualities.large }
        ];

        console.log(`\n📦 Génération AVIF :`);

        sizes.forEach(size => {
            tasks.push(
                sharp(inputBuffer)
                    .resize({ width: size.width, withoutEnlargement: true })
                    .toFormat('avif', { 
                        quality: size.quality, 
                        effort: 3  // Bon compromis vitesse/qualité
                    })
                    .toBuffer()
                    .then(buffer => {
                        const sizeKo = (buffer.length / 1024).toFixed(1);
                        console.log(`   ${size.name}: ${size.width}px @ Q${size.quality} → ${sizeKo} Ko`);
                        return { type: 'image', size: size.name, data: buffer.toString('base64') };
                    })
                    .catch(err => { 
                        console.error(`   ❌ Erreur ${size.name}:`, err.message); 
                        return null; 
                    })
            );
        });

        // --- TÂCHE B : IA GEMINI ---
        if (API_KEY_GEMINI) {
            tasks.push((async () => {
                try {
                    const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                    
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
                    return { type: 'seo', data: JSON.parse(text) };

                } catch (err) {
                    console.error(`   ⚠️ Gemini échoué:`, err.message);
                    return { type: 'seo', data: null };
                }
            })());
        }

        // 6. ATTENTE ET RÉPONSE
        const results = await Promise.all(tasks);
        const responseData = { images: {}, seo: null };

        results.forEach(item => {
            if (!item) return;
            if (item.type === 'image') responseData.images[item.size] = item.data;
            if (item.type === 'seo') responseData.seo = item.data;
        });

        // Stats
        const totalAvifSize = Object.values(responseData.images).reduce((acc, b64) => {
            return acc + Buffer.from(b64, 'base64').length;
        }, 0);
        const avgSize = totalAvifSize / 4;
        const reduction = ((1 - avgSize / imageFile.size) * 100).toFixed(0);
        
        console.log(`\n✅ Terminé !`);
        console.log(`   ${Object.keys(responseData.images).length} AVIF générés`);
        console.log(`   Réduction moyenne : ${reduction}%`);
        console.log(`${'─'.repeat(50)}\n`);
        
        res.json(responseData);

    } catch (error) {
        console.error("❌ Erreur:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏭 Usine V10 démarrée sur le port ${PORT}`));
