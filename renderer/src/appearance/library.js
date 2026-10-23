// Appearance library (0.1.106): how a part looks in the Shaded and Realistic display styles. Data list, like
// MATERIALS in part/part.js (each material names its default appearance there). A part / component stores only
// { name } plus the values changed by hand (color, roughness, metalness, opacity), see look.js resolveAppearance.
// Fields: cat (group in the popup), color, metalness 0..1, roughness 0..1, clearcoat 0..1 (lacquer layer),
// opacity 0..1, tex = generated texture shown in Realistic (TEXTURES below, appearance/textures.js).
export const APPEARANCE_CATS = ['Metal', 'Plastic', 'Paint', 'Rubber', 'Wood', 'Glass'];
export const APPEARANCES = [
  // metals
  { name: 'Satin Steel', cat: 'Metal', color: '#b4b8be', metalness: 1, roughness: 0.38 },
  { name: 'Polished Steel', cat: 'Metal', color: '#c6c9ce', metalness: 1, roughness: 0.14 },
  { name: 'Brushed Steel', cat: 'Metal', color: '#bcc0c5', metalness: 1, roughness: 0.3, tex: 'brushed' },
  { name: 'Stainless Steel', cat: 'Metal', color: '#c2c5c9', metalness: 1, roughness: 0.26 },
  { name: 'Galvanised Steel', cat: 'Metal', color: '#b2b8bd', metalness: 1, roughness: 0.48, tex: 'grain' },
  { name: 'Knurled Steel', cat: 'Metal', color: '#b9bdc2', metalness: 1, roughness: 0.34, tex: 'knurl' },
  { name: 'Cast Iron', cat: 'Metal', color: '#5e6064', metalness: 0.85, roughness: 0.7, tex: 'cast' },
  { name: 'Satin Aluminium', cat: 'Metal', color: '#d2d5d9', metalness: 1, roughness: 0.32 },
  { name: 'Polished Aluminium', cat: 'Metal', color: '#dfe1e4', metalness: 1, roughness: 0.1 },
  { name: 'Anodised Black', cat: 'Metal', color: '#2a2c30', metalness: 0.6, roughness: 0.35, clearcoat: 0.3 },
  { name: 'Anodised Blue', cat: 'Metal', color: '#2b5294', metalness: 0.6, roughness: 0.35, clearcoat: 0.3 },
  { name: 'Anodised Red', cat: 'Metal', color: '#952f2f', metalness: 0.6, roughness: 0.35, clearcoat: 0.3 },
  { name: 'Chrome', cat: 'Metal', color: '#e9ebef', metalness: 1, roughness: 0.04 },
  { name: 'Brass', cat: 'Metal', color: '#d6b46c', metalness: 1, roughness: 0.25 },
  { name: 'Copper', cat: 'Metal', color: '#c9805b', metalness: 1, roughness: 0.25 },
  { name: 'Bronze', cat: 'Metal', color: '#a87b46', metalness: 1, roughness: 0.35 },
  { name: 'Gold', cat: 'Metal', color: '#e8c55e', metalness: 1, roughness: 0.15 },
  { name: 'Titanium', cat: 'Metal', color: '#aaa59d', metalness: 1, roughness: 0.35 },
  // plastics
  { name: 'Glossy White Plastic', cat: 'Plastic', color: '#f2f2f0', metalness: 0, roughness: 0.25, clearcoat: 0.5 },
  { name: 'Glossy Black Plastic', cat: 'Plastic', color: '#18181a', metalness: 0, roughness: 0.25, clearcoat: 0.5 },
  { name: 'Glossy Red Plastic', cat: 'Plastic', color: '#c21a1f', metalness: 0, roughness: 0.25, clearcoat: 0.5 },
  { name: 'Glossy Blue Plastic', cat: 'Plastic', color: '#1d50b4', metalness: 0, roughness: 0.25, clearcoat: 0.5 },
  { name: 'Glossy Yellow Plastic', cat: 'Plastic', color: '#efc000', metalness: 0, roughness: 0.25, clearcoat: 0.5 },
  { name: 'Matte White Plastic', cat: 'Plastic', color: '#e8e8e5', metalness: 0, roughness: 0.62 },
  { name: 'Matte Grey Plastic', cat: 'Plastic', color: '#8c8f94', metalness: 0, roughness: 0.62 },
  { name: 'Matte Black Plastic', cat: 'Plastic', color: '#202124', metalness: 0, roughness: 0.62 },
  { name: 'Textured Black Plastic', cat: 'Plastic', color: '#1f2023', metalness: 0, roughness: 0.82, tex: 'grain' },
  { name: 'Natural Nylon', cat: 'Plastic', color: '#e6e0cc', metalness: 0, roughness: 0.55 },
  // paints
  { name: 'Gloss Paint White', cat: 'Paint', color: '#f4f4f2', metalness: 0, roughness: 0.3, clearcoat: 1 },
  { name: 'Gloss Paint Black', cat: 'Paint', color: '#141416', metalness: 0, roughness: 0.3, clearcoat: 1 },
  { name: 'Gloss Paint Red', cat: 'Paint', color: '#b3161b', metalness: 0, roughness: 0.3, clearcoat: 1 },
  { name: 'Gloss Paint Blue', cat: 'Paint', color: '#174a9c', metalness: 0, roughness: 0.3, clearcoat: 1 },
  { name: 'Gloss Paint Green', cat: 'Paint', color: '#1f6b3a', metalness: 0, roughness: 0.3, clearcoat: 1 },
  { name: 'Gloss Paint Yellow', cat: 'Paint', color: '#f0b400', metalness: 0, roughness: 0.3, clearcoat: 1 },
  { name: 'Metallic Paint Silver', cat: 'Paint', color: '#a9adb3', metalness: 0.7, roughness: 0.35, clearcoat: 1 },
  { name: 'Powder Coat Black', cat: 'Paint', color: '#1c1d20', metalness: 0, roughness: 0.55 },
  { name: 'Powder Coat Grey', cat: 'Paint', color: '#7b7f85', metalness: 0, roughness: 0.55 },
  { name: 'Powder Coat White', cat: 'Paint', color: '#ecebe7', metalness: 0, roughness: 0.55 },
  // rubber
  { name: 'Black Rubber', cat: 'Rubber', color: '#1b1b1c', metalness: 0, roughness: 0.92 },
  { name: 'Grey Rubber', cat: 'Rubber', color: '#56595d', metalness: 0, roughness: 0.92 },
  // wood
  { name: 'Oak', cat: 'Wood', color: '#b98d58', metalness: 0, roughness: 0.6, tex: 'wood' },
  { name: 'Walnut', cat: 'Wood', color: '#6b4a2e', metalness: 0, roughness: 0.55, tex: 'wood' },
  { name: 'Pine', cat: 'Wood', color: '#d8b57f', metalness: 0, roughness: 0.6, tex: 'wood' },
  { name: 'Birch Plywood', cat: 'Wood', color: '#dcc59a', metalness: 0, roughness: 0.6, tex: 'wood' },
  // glass / clear
  { name: 'Clear Glass', cat: 'Glass', color: '#e8f0f0', metalness: 0, roughness: 0.05, opacity: 0.25, clearcoat: 1 },
  { name: 'Tinted Glass', cat: 'Glass', color: '#5f7d7c', metalness: 0, roughness: 0.05, opacity: 0.4, clearcoat: 1 },
  { name: 'Clear Acrylic', cat: 'Glass', color: '#f2f4f5', metalness: 0, roughness: 0.1, opacity: 0.35, clearcoat: 0.6 },
  { name: 'Smoked Acrylic', cat: 'Glass', color: '#3a3c40', metalness: 0, roughness: 0.1, opacity: 0.5, clearcoat: 0.6 },
];
// Generated textures (0.1.110, Realistic only): tile = size of one texture tile on the part (mm, × the appearance's
// texture scale); color / rough = how much the grey value changes the colour / roughness (±); bump = surface relief.
export const TEXTURES = {
  brushed: { label: 'Brushed', tile: 30, color: 0.05, rough: 0.12, bump: 0.35 },
  wood: { label: 'Wood', tile: 150, color: 0.32, rough: 0.1, bump: 0.04 },
  cast: { label: 'Cast', tile: 40, color: 0.14, rough: 0.15, bump: 0.8 },
  knurl: { label: 'Knurl', tile: 6, color: 0.08, rough: 0.05, bump: 2.5 },
  grain: { label: 'Grain', tile: 12, color: 0.07, rough: 0.1, bump: 0.5 },
};
export const appearanceByName = (n) => APPEARANCES.find((a) => a.name === n) || null;
