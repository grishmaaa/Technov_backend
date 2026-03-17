/**
 * test-evolink-format.js
 * 
 * Simulated test to verify the EXACT JSON structure being sent to EvoLink
 * for Kling Custom Elements, using the latest logic in evolinkService.js
 */

const testElementFormat = (name, description, facialImageUrl) => {
    console.log("--- SIMULATING KLING CUSTOM ELEMENT PAYLOAD ---");
    console.log("Input Name:", name);
    console.log("Input Description:", description);

    // 1. Force the description to be purely about physical facial traits (Extreme Sanitization)
    const cleanDesc = (description || '')
        .replace(/\b(the unseen driver of|the driver of|the sports car|pursuer|mysterious|aggressive|relentless|unseen|motorcycle|helmet|racer|bikes|riding|wearing a|in a|with a|races|suit|jacket|coat|scarf|mask|visor|action|running|pedaling|driver of a|matte black sports car|girl on a bicycle|the girl|the biker|rider)\b[^,.]*/gi, '')
        .replace(/\b(the|a|an|of|in|with|and|is|was|were)\b/gi, ' ') // Scrub common story connectors
        .replace(/\s+/g, ' ')
        .trim();

    // 2. Biometric-only fallback
    const finalDescription = (cleanDesc.length > 3)
        ? `A detailed human portrait showing ${cleanDesc}`
        : "A clear human portrait, standard facial features, centered facial structure.";

    const safeName = (name || 'Character').substring(0, 20);
    const safeDescription = finalDescription.substring(0, 100);

    // 3. EXACT structure construction
    const payload = {
        model: 'kling-custom-element',
        model_params: {
            element_name: safeName,
            element_description: safeDescription,
            reference_type: 'image_refer',
            element_image_list: {
                frontal_image: facialImageUrl,
            }
        },
        standard_model_name: 'kling-custom-element'
    };

    console.log("\n🚀 FINAL JSON PAYLOAD FOR EVOLINK:");
    console.log(JSON.stringify(payload, null, 2));
    console.log("");
};

// RUN TEST for "The Driver" (Bad Case)
testElementFormat(
    "The Driver",
    "The unseen driver of the matte black sports car, an aggressive and mysterious pursuer with a sharp jawline and cold eyes",
    "https://storage.googleapis.com/test-bucket/face.jpg"
);

// RUN TEST for "Auburn Girl" (Good Case)
testElementFormat(
    "Auburn Girl",
    "A young woman with auburn hair and green eyes. She is riding a bicycle.",
    "https://storage.googleapis.com/test-bucket/girl.jpg"
);
