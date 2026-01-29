import { PrismaClient, SkuType, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// ============================================
// CATEGORY & MATERIAL INFERENCE
// ============================================

function inferCategory(sku: string, name: string): string {
  // Tips and ferrules
  if (sku.includes("TIP") || sku.includes("TIPPED") || name.includes("Tip")) return "Tips";
  if (sku.includes("FERRULE")) return "Ferrules";

  // Springs
  if (sku.includes("SPRING")) return "Springs";

  // Rings and locks
  if (sku.includes("RING") || sku.includes("LOCK")) return "Rings & Locks";

  // Studs
  if (sku.includes("STUD")) return "Studs";

  // Blades
  if (sku.includes("BLADE")) return "Blades";

  // Pins
  if (sku.includes("PIN")) return "Pins";

  // Packaging
  if (sku.includes("PACK") || sku.includes("BACKER") || sku.includes("CLAMSHELL")) return "Packaging";

  // Broadheads (assembled products)
  if (name.includes("BROADHEAD")) return "Broadheads";

  // Accessories
  if (sku.includes("BEAST-") && (sku.includes("AID") || sku.includes("BAND") || sku.includes("FP") || sku.includes("STICKER") || sku.includes("INSERT"))) {
    return "Accessories";
  }

  // Practice tips
  if (sku.includes("PT-") && name.includes("Practice")) return "Practice Tips";

  return "Other";
}

function inferMaterial(sku: string, name: string): string {
  // Titanium
  if (sku.startsWith("TI-") || name.includes("TITANIUM") || name.includes("Titanium")) return "Titanium";

  // Steel
  if (sku.startsWith("ST-") || sku.includes("STEEL") || name.includes("STEEL") || name.includes("Steel")) return "Steel";

  // Trump (special aluminum)
  if (sku.startsWith("TR-") || name.includes("TRUMP")) return "Aluminum (Trump)";

  // Deep6 (special aluminum)
  if (sku.startsWith("D6-") || name.includes("DEEP6") || name.includes("Deep 6") || name.includes("D6")) return "Aluminum (D6)";

  // Standard aluminum (default for most SKUs that aren't steel or titanium)
  if (sku.includes("BEAST") || sku.includes("FERRULE") || sku.includes("STUD-")) return "Aluminum";

  // Blades (typically stainless steel)
  if (sku.includes("BLADE") && !sku.includes("BLADED")) return "Stainless Steel";

  // Springs (stainless steel)
  if (sku.includes("SPRING")) return "Stainless Steel";

  // Packaging materials
  if (sku.includes("BACKER") || sku.includes("CLAMSHELL")) return "Cardboard/Plastic";

  // Accessories
  if (sku.includes("BAND")) return "Elastic";
  if (sku.includes("STICKER")) return "Vinyl";
  if (sku.includes("INSERT")) return "Paper/Cardboard";

  return "Mixed/Other";
}

/**
 * Convert ALL CAPS names to Title Case for cleaner display
 * Special handling for abbreviations like GR, IN, etc.
 */
function toTitleCase(str: string): string {
  // Words that should stay uppercase
  const keepUpperCase = new Set(["GR", "IN", "CUT", "ID", "FP", "PT", "ST", "TI", "TR", "D6"]);

  // Words that should stay lowercase (unless first word)
  const keepLowerCase = new Set(["a", "an", "and", "the", "of", "for", "in", "on", "at", "to"]);

  return str
    .split(/(\s+|-|,)/) // Split on spaces, hyphens, commas but keep delimiters
    .map((word, index) => {
      if (!word.trim()) return word; // Keep whitespace/delimiters as-is

      const upperWord = word.toUpperCase();

      // Keep certain abbreviations in uppercase
      if (keepUpperCase.has(upperWord)) {
        return upperWord;
      }

      // First word is always capitalized
      if (index === 0) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }

      // Keep certain words lowercase unless they're first
      if (keepLowerCase.has(word.toLowerCase())) {
        return word.toLowerCase();
      }

      // Default: capitalize first letter, lowercase rest
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join("");
}

// ============================================
// SKU DATA FROM CSV
// ============================================

const skuData: { sku: string; name: string; type: SkuType }[] = [
  // ASSEMBLIES - Individual broadheads and sub-assemblies
  { sku: "23IN-100G-BEAST", name: "BROADHEAD- 2.3 IN CUT - 100 GR", type: "ASSEMBLY" },
  { sku: "23IN-125G-BEAST", name: "BROADHEAD- 2.3 IN CUT - 125 GR", type: "ASSEMBLY" },
  { sku: "23IN-BLADED-FERRULE", name: "23in Bladed Aluminum Ferrule", type: "ASSEMBLY" },
  { sku: "2IN-100G-BEAST", name: "BROADHEAD- 2.0 IN CUT - 100 GR", type: "ASSEMBLY" },
  { sku: "2IN-125G-BEAST", name: "BROADHEAD- 2.0 IN CUT - 125 GR", type: "ASSEMBLY" },
  { sku: "2IN-BLADED-FERRULE", name: "2in Bladed Aluminum Ferrule", type: "ASSEMBLY" },
  { sku: "D6-23IN-100G-BEAST", name: "DEEP6 100g 2.3 IN CUT- 100G", type: "ASSEMBLY" },
  { sku: "D6-23IN-125G-BEAST", name: "DEEP6 100g 2.3 IN CUT- 125G", type: "ASSEMBLY" },
  { sku: "D6-2IN-100G-BEAST", name: "DEEP6 100g 2.0 IN CUT- 100G", type: "ASSEMBLY" },
  { sku: "D6-2IN-125G-BEAST", name: "DEEP6 100g 2.0 IN CUT- 125G", type: "ASSEMBLY" },
  { sku: "ST-2IN-150G-BEAST", name: "STEEL BROADHEAD- 2 IN CUT - 150GR", type: "ASSEMBLY" },
  { sku: "ST-2IN-BLADED-FERRULE", name: "BLADED STEEL 2IN-150G", type: "ASSEMBLY" },
  { sku: "ST-TIPPED-FERRULE", name: "TIPPED ST-2IN-150G", type: "ASSEMBLY" },
  { sku: "TI-100-TIPPED-FERRULE", name: "TIPPED TITANIUM FERRULE -100GR", type: "ASSEMBLY" },
  { sku: "TI-2IN-100G-BEAST", name: "TITANIUM BROADHEAD- 2.0 IN CUT - 100 GR", type: "ASSEMBLY" },
  { sku: "TI-2IN-100G-BLADED-FERRULE", name: "2in BLADED TITANIUM FERRULE -100GR", type: "ASSEMBLY" },
  { sku: "TI-2IN-125G-BEAST", name: "TITANIUM BROADHEAD- 2.0 IN CUT - 125 GR", type: "ASSEMBLY" },
  { sku: "TI-2IN-BLADED-FERRULE", name: "2in BLADED TITANIUM FERRULE - 125GR", type: "ASSEMBLY" },
  { sku: "TI-TIPPED-FERRULE", name: "TIPPED TITANIUM FERRULE - 125GR", type: "ASSEMBLY" },
  { sku: "TIPPED-FERRULE", name: "Aluminum Tipped Ferrule", type: "ASSEMBLY" },
  { sku: "TR-23IN-100G-BEAST", name: "TRUMP BROADHEAD- 2.30 IN CUT - 100 GR", type: "ASSEMBLY" },
  { sku: "TR-23IN-125G-BEAST", name: "TRUMP BROADHEAD- 2.3 IN CUT - 125GR", type: "ASSEMBLY" },
  { sku: "TR-23IN-BLADED-FERRULE", name: "BLADED TRUMP -23IN", type: "ASSEMBLY" },
  { sku: "TR-2IN-100G-BEAST", name: "TRUMP BROADHEAD- 2.0 IN CUT - 100 GR", type: "ASSEMBLY" },
  { sku: "TR-2IN-125G-BEAST", name: "TRUMP BROADHEAD- 2.0 IN CUT - 125GR", type: "ASSEMBLY" },
  { sku: "TR-2IN-BLADED-FERRULE", name: "BLADED TRUMP -2IN", type: "ASSEMBLY" },
  { sku: "TR-TIPPED-FERRULE", name: "TRUMP TIPPED FERRULE", type: "ASSEMBLY" },
  { sku: "BEAST-INSERT", name: "Complete Bandee Bands", type: "ASSEMBLY" },
  { sku: "TI-23IN-125G-BEAST", name: "TITANIUM BROADHEAD- 2.3 IN CUT - 125 GR", type: "ASSEMBLY" },
  { sku: "TI-23IN-100G-BEAST", name: "TITANIUM BROADHEAD- 2.3 IN CUT - 100 GR", type: "ASSEMBLY" },
  { sku: "TI-23IN-100G-BLADED-FERRULE", name: "2.3in BLADED TITANIUM FERRULE -100GR", type: "ASSEMBLY" },
  { sku: "TI-23IN-BLADED-FERRULE", name: "2.3in BLADED TITANIUM FERRULE -125GR", type: "ASSEMBLY" },

  // COMPLETED UNITS - Packages ready to ship
  { sku: "2PACK-100g-2.0in", name: "BROADHEAD 2 PACK- 2.0IN 100GR", type: "COMPLETED" },
  { sku: "2PACK-100g-2.3in", name: "BROADHEAD 2 PACK- 2.3IN 100GR", type: "COMPLETED" },
  { sku: "2PACK-125g-2.0in", name: "BROADHEAD 2 PACK- 2.0IN 125GR", type: "COMPLETED" },
  { sku: "2PACK-125g-2.3in", name: "BROADHEAD 2 PACK- 2.3IN 125GR", type: "COMPLETED" },
  { sku: "3PACK-100g-2.0in", name: "BROADHEAD 3 PACK- 2.0IN 100GR", type: "COMPLETED" },
  { sku: "3PACK-100g-2.3in", name: "BROADHEAD 3 PACK- 2.3IN 100GR", type: "COMPLETED" },
  { sku: "3PACK-125g-2.0in", name: "BROADHEAD 3 PACK- 2.0IN 125GR", type: "COMPLETED" },
  { sku: "3PACK-125g-2.3in", name: "BROADHEAD 3 PACK- 2.3IN 125GR", type: "COMPLETED" },
  { sku: "D6-3PACK-23IN-100G", name: "D6 BROADHEAD 3 PACK- 2.3IN 100GR", type: "COMPLETED" },
  { sku: "D6-3PACK-23IN-125G", name: "D6 BROADHEAD 3 PACK- 2.3IN 125GR", type: "COMPLETED" },
  { sku: "D6-3PACK-2IN-100G", name: "D6 BROADHEAD 3 PACK- 2.0IN 100GR", type: "COMPLETED" },
  { sku: "D6-3PACK-2IN-125G", name: "D6 BROADHEAD 3 PACK- 2.0IN 125GR", type: "COMPLETED" },
  { sku: "PT-100G-BEAST", name: "Practice Tip 3 pack 100GR", type: "COMPLETED" },
  { sku: "PT-125G-BEAST", name: "Practice Tip 3 pack 125GR", type: "COMPLETED" },
  { sku: "ST-3PACK-2IN-150G", name: "STEEL BROADHEAD 3 PACK- 2IN 150GR", type: "COMPLETED" },
  { sku: "TI-2PACK-125g-2.0in", name: "TITANIUM BROADHEAD 2 PACK- 2.0IN 125GR", type: "COMPLETED" },
  { sku: "TI-3PACK-100g-2.0in", name: "TITANIUM BROADHEAD 3 PACK- 2.0IN 100GR", type: "COMPLETED" },
  { sku: "TI-3PACK-100g-2.3in", name: "TITANIUM BROADHEAD 3 PACK- 2.3IN 100GR", type: "COMPLETED" },
  { sku: "TI-3PACK-125g-2.0in", name: "TITANIUM BROADHEAD 3 PACK- 2.0IN 125GR", type: "COMPLETED" },
  { sku: "TI-3PACK-125g-2.3in", name: "TITANIUM BROADHEAD 3 PACK- 2.3IN 125GR", type: "COMPLETED" },
  { sku: "TR-3PACK-23IN-100G", name: "TRUMP BROADHEAD 3 PACK- 2.3IN 100GR", type: "COMPLETED" },
  { sku: "TR-3PACK-23IN-125G", name: "TRUMP BROADHEAD 3 PACK- 2.3IN 125GR", type: "COMPLETED" },
  { sku: "TR-3PACK-2IN-100G", name: "TRUMP BROADHEAD 3 PACK- 2.0IN 100GR", type: "COMPLETED" },
  { sku: "TR-3PACK-2IN-125G", name: "TRUMP BROADHEAD 3 PACK- 2.0IN 125GR", type: "COMPLETED" },

  // RAW MATERIALS
  { sku: "BACKER-23IN-100G-2COUNT", name: "2.3 100g (2 pack) Backer Card", type: "RAW" },
  { sku: "BACKER-23IN-100G-3COUNT", name: "2.3 100g (3 pack) Backer Card", type: "RAW" },
  { sku: "BACKER-23IN-125G-2COUNT", name: "2.3 125g (2 pack) Backer Card", type: "RAW" },
  { sku: "BACKER-23IN-125G-3COUNT", name: "2.3 125g (3 pack) Backer card", type: "RAW" },
  { sku: "BACKER-2IN-100G-2COUNT", name: "2.0 100g (2 pack) Backer Card", type: "RAW" },
  { sku: "BACKER-2IN-100G-3COUNT", name: "2.0 100g (3 pack) Backer Card", type: "RAW" },
  { sku: "BACKER-2IN-125G-2COUNT", name: "2.0 125g (2 pack) Backer Card", type: "RAW" },
  { sku: "BACKER-2IN-125G-3COUNT", name: "2.0 125g (3 pack) Backer card", type: "RAW" },
  { sku: "BACKER-D6-23IN-100G-3COUNT", name: "2.3 100g (3 pack) Deep 6 BC", type: "RAW" },
  { sku: "BACKER-D6-23IN-125G-3COUNT", name: "2.3 125g (3 pack) Deep 6 BC", type: "RAW" },
  { sku: "BACKER-D6-2IN-100G-3COUNT", name: "2.0 100g (3 pack) Deep 6 BC", type: "RAW" },
  { sku: "BACKER-D6-2IN-125G-3COUNT", name: "2.0 125g (3 pack) Deep 6 BC", type: "RAW" },
  { sku: "BACKER-INSERT", name: "Beast Backer Card Standout", type: "RAW" },
  { sku: "BACKER-PT-100G-3COUNT", name: "3 pack PT Backer Card 100g", type: "RAW" },
  { sku: "BACKER-PT-125G-3COUNT", name: "3 pack PT Backer Card 125g", type: "RAW" },
  { sku: "BACKER-ST-2IN-150G-3COUNT", name: "2.0 150g (3 pack) Steel BC", type: "RAW" },
  { sku: "BACKER-TI-2IN-100G-3COUNT", name: "2.0 100g (3 pack) Titanium BC", type: "RAW" },
  { sku: "BACKER-TI-23IN-100G-3COUNT", name: "2.3 100g (3 pack) Titanium BC", type: "RAW" },
  { sku: "BACKER-TI-2IN-125G-2COUNT", name: "2.0 125g (2 pack) Titanium BC", type: "RAW" },
  { sku: "BACKER-TI-2IN-125G-3COUNT", name: "2.0 125g (3 pack) Titanium BC", type: "RAW" },
  { sku: "BACKER-TI-23IN-125G-3COUNT", name: "2.3 125g (3 pack) Titanium BC", type: "RAW" },
  { sku: "BACKER-TR-23IN-100G-3COUNT", name: "2.3 100g (3 pack) TRUMP Backer Card", type: "RAW" },
  { sku: "BACKER-TR-23IN-125G-3COUNT", name: "2.3 125g (3 pack) TRUMP Backer Card", type: "RAW" },
  { sku: "BACKER-TR-2IN-100G-3COUNT", name: "2.0 100g (3 pack) TRUMP Backer Card", type: "RAW" },
  { sku: "BACKER-TR-2IN-125G-3COUNT", name: "2.0 125g (3 pack) TRUMP Backer Card", type: "RAW" },
  { sku: "BEAST-AID", name: "Beast Band-aid", type: "RAW" },
  { sku: "BEAST-BAND", name: "Elastic (for Bandee-Bands)", type: "RAW" },
  { sku: "BEAST-CLAMSHELL", name: "Clamshell", type: "RAW" },
  { sku: "BEAST-FP", name: "Finger Protector", type: "RAW" },
  { sku: "BEAST-STICKER", name: "Beast Sticker", type: "RAW" },
  { sku: "BLADE-23IN", name: "Blade [2.3 IN]", type: "RAW" },
  { sku: "BLADE-2IN", name: "Blade [2.0 IN]", type: "RAW" },
  { sku: "BLADE-LOCK", name: "Blade Lock", type: "RAW" },
  { sku: "BLADE-PIN", name: "Blade pin", type: "RAW" },
  { sku: "D6-BEAST-CLAMSHELL", name: "D6 Clamshell", type: "RAW" },
  { sku: "D6-STUD-100G", name: "D6 Stud [Aluminum]", type: "RAW" },
  { sku: "D6-STUD-125G", name: "D6 Stud [Steel]", type: "RAW" },
  { sku: "TI-STUD-100G", name: "Titanium 100g Stud", type: "RAW" },
  { sku: "FERRULE", name: "Ferrule", type: "RAW" },
  { sku: "PT-100G", name: "Practice Tip-100G", type: "RAW" },
  { sku: "PT-125G", name: "Practice Tip-125G", type: "RAW" },
  { sku: "PT-BEAST-CLAMSHELL", name: "PT Clamshell", type: "RAW" },
  { sku: "SPRING-INNER", name: "Spring [Inner]", type: "RAW" },
  { sku: "SPRING-OUTER", name: "Spring [Outer]", type: "RAW" },
  { sku: "ST-BACKER-INSERT", name: "Steel Beast Standout (Green-Grey)", type: "RAW" },
  { sku: "ST-FERRULE", name: "Steel Ferrule", type: "RAW" },
  { sku: "STUD-100G", name: "Stud [Aluminum]", type: "RAW" },
  { sku: "STUD-125G", name: "Stud [Steel]", type: "RAW" },
  { sku: "TI-100-BLADE-PIN", name: "Titanium 100g Blade Pin", type: "RAW" },
  { sku: "TI-100-FERRULE", name: "Titanium 100g Ferrule", type: "RAW" },
  { sku: "TI-100-TIP-STEEL", name: "Tip [Steel 100g]", type: "RAW" },
  { sku: "TI-BACKER-INSERT", name: "Titanium Beast Standout (Grey-Grey)", type: "RAW" },
  { sku: "TI-BLADE-PIN", name: "Titanium Blade Pin", type: "RAW" },
  { sku: "TI-FERRULE", name: "Titanium Ferrule", type: "RAW" },
  { sku: "TI-STUD-125G", name: "Titanium Stud 125G", type: "RAW" },
  { sku: "TIP-STEEL", name: "Tip [Steel]", type: "RAW" },
  { sku: "TR-BACKER-INSERT", name: "Trump Backer Card Beast Standout", type: "RAW" },
  { sku: "TR-FERRULE", name: "Trump Ferrule", type: "RAW" },
  { sku: "TR-STUD-100G", name: "Trump Stud [Aluminum]", type: "RAW" },
  { sku: "SPRING-MICRO", name: "Spring [Micro]", type: "RAW" },
];

// ============================================
// BILL OF MATERIALS DATA
// ============================================

// Format: { parent: "PARENT-SKU", components: [{ sku: "COMPONENT-SKU", qty: number }] }
const bomData: { parent: string; components: { sku: string; qty: number }[] }[] = [
  // === SUB-ASSEMBLIES (Work Order Steps) ===

  // TIPPED FERRULES (WO1)
  { parent: "TIPPED-FERRULE", components: [
    { sku: "FERRULE", qty: 1 },
    { sku: "TIP-STEEL", qty: 1 },
  ]},
  { parent: "TI-TIPPED-FERRULE", components: [
    { sku: "TI-FERRULE", qty: 1 },
    { sku: "TIP-STEEL", qty: 1 },
  ]},
  { parent: "TI-100-TIPPED-FERRULE", components: [
    { sku: "TI-100-FERRULE", qty: 1 },
    { sku: "TI-100-TIP-STEEL", qty: 1 },
  ]},
  { parent: "TR-TIPPED-FERRULE", components: [
    { sku: "TR-FERRULE", qty: 1 },
    { sku: "TIP-STEEL", qty: 1 },
  ]},
  { parent: "ST-TIPPED-FERRULE", components: [
    { sku: "ST-FERRULE", qty: 1 },
    { sku: "TIP-STEEL", qty: 1 },
  ]},

  // BLADED FERRULES (WO2)
  { parent: "2IN-BLADED-FERRULE", components: [
    { sku: "TIPPED-FERRULE", qty: 1 },
    { sku: "BLADE-2IN", qty: 2 },
    { sku: "BLADE-PIN", qty: 1 },
  ]},
  { parent: "23IN-BLADED-FERRULE", components: [
    { sku: "TIPPED-FERRULE", qty: 1 },
    { sku: "BLADE-23IN", qty: 2 },
    { sku: "BLADE-PIN", qty: 1 },
  ]},
  { parent: "TI-2IN-BLADED-FERRULE", components: [
    { sku: "TI-TIPPED-FERRULE", qty: 1 },
    { sku: "BLADE-2IN", qty: 2 },
    { sku: "TI-BLADE-PIN", qty: 1 },
  ]},
  { parent: "TI-23IN-BLADED-FERRULE", components: [
    { sku: "TI-TIPPED-FERRULE", qty: 1 },
    { sku: "BLADE-23IN", qty: 2 },
    { sku: "TI-BLADE-PIN", qty: 1 },
  ]},
  { parent: "TI-2IN-100G-BLADED-FERRULE", components: [
    { sku: "TI-100-TIPPED-FERRULE", qty: 1 },
    { sku: "BLADE-2IN", qty: 2 },
    { sku: "TI-100-BLADE-PIN", qty: 1 },
  ]},
  { parent: "TI-23IN-100G-BLADED-FERRULE", components: [
    { sku: "TI-100-TIPPED-FERRULE", qty: 1 },
    { sku: "BLADE-23IN", qty: 2 },
    { sku: "TI-100-BLADE-PIN", qty: 1 },
  ]},
  { parent: "TR-2IN-BLADED-FERRULE", components: [
    { sku: "TR-TIPPED-FERRULE", qty: 1 },
    { sku: "BLADE-2IN", qty: 2 },
    { sku: "BLADE-PIN", qty: 1 },
  ]},
  { parent: "TR-23IN-BLADED-FERRULE", components: [
    { sku: "TR-TIPPED-FERRULE", qty: 1 },
    { sku: "BLADE-23IN", qty: 2 },
    { sku: "BLADE-PIN", qty: 1 },
  ]},
  { parent: "ST-2IN-BLADED-FERRULE", components: [
    { sku: "ST-TIPPED-FERRULE", qty: 1 },
    { sku: "BLADE-2IN", qty: 2 },
    { sku: "BLADE-PIN", qty: 1 },
  ]},

  // === COMPLETE BROADHEADS (WO3) ===

  // Standard Aluminum 2.0"
  { parent: "2IN-100G-BEAST", components: [
    { sku: "2IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "STUD-100G", qty: 1 },
  ]},
  { parent: "2IN-125G-BEAST", components: [
    { sku: "2IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "STUD-125G", qty: 1 },
  ]},

  // Standard Aluminum 2.3"
  { parent: "23IN-100G-BEAST", components: [
    { sku: "23IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "STUD-100G", qty: 1 },
  ]},
  { parent: "23IN-125G-BEAST", components: [
    { sku: "23IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "STUD-125G", qty: 1 },
  ]},

  // Deep6 variants
  { parent: "D6-2IN-100G-BEAST", components: [
    { sku: "2IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "D6-STUD-100G", qty: 1 },
  ]},
  { parent: "D6-2IN-125G-BEAST", components: [
    { sku: "2IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "D6-STUD-125G", qty: 1 },
  ]},
  { parent: "D6-23IN-100G-BEAST", components: [
    { sku: "23IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "D6-STUD-100G", qty: 1 },
  ]},
  { parent: "D6-23IN-125G-BEAST", components: [
    { sku: "23IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "D6-STUD-125G", qty: 1 },
  ]},

  // Titanium 125g variants
  { parent: "TI-2IN-125G-BEAST", components: [
    { sku: "TI-2IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "TI-STUD-125G", qty: 1 },
  ]},
  { parent: "TI-23IN-125G-BEAST", components: [
    { sku: "TI-23IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "TI-STUD-125G", qty: 1 },
  ]},

  // Titanium 100g variants
  { parent: "TI-2IN-100G-BEAST", components: [
    { sku: "TI-2IN-100G-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "TI-STUD-100G", qty: 1 },
  ]},
  { parent: "TI-23IN-100G-BEAST", components: [
    { sku: "TI-23IN-100G-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "TI-STUD-100G", qty: 1 },
  ]},

  // Trump variants
  { parent: "TR-2IN-100G-BEAST", components: [
    { sku: "TR-2IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "TR-STUD-100G", qty: 1 },
  ]},
  { parent: "TR-2IN-125G-BEAST", components: [
    { sku: "TR-2IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "STUD-125G", qty: 1 },
  ]},
  { parent: "TR-23IN-100G-BEAST", components: [
    { sku: "TR-23IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "TR-STUD-100G", qty: 1 },
  ]},
  { parent: "TR-23IN-125G-BEAST", components: [
    { sku: "TR-23IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "STUD-125G", qty: 1 },
  ]},

  // Steel variant
  { parent: "ST-2IN-150G-BEAST", components: [
    { sku: "ST-2IN-BLADED-FERRULE", qty: 1 },
    { sku: "SPRING-OUTER", qty: 1 },
    { sku: "SPRING-INNER", qty: 1 },
    { sku: "BLADE-LOCK", qty: 1 },
    { sku: "TI-STUD-125G", qty: 1 },
  ]},

  // === COMPLETED PACKAGES ===

  // 2-Packs Standard
  { parent: "2PACK-100g-2.0in", components: [
    { sku: "2IN-100G-BEAST", qty: 2 },
    { sku: "PT-100G", qty: 1 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-2IN-100G-2COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "2PACK-125g-2.0in", components: [
    { sku: "2IN-125G-BEAST", qty: 2 },
    { sku: "PT-125G", qty: 1 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-2IN-125G-2COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "2PACK-100g-2.3in", components: [
    { sku: "23IN-100G-BEAST", qty: 2 },
    { sku: "PT-100G", qty: 1 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-23IN-100G-2COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "2PACK-125g-2.3in", components: [
    { sku: "23IN-125G-BEAST", qty: 2 },
    { sku: "PT-125G", qty: 1 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-23IN-125G-2COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},

  // 3-Packs Standard
  { parent: "3PACK-100g-2.0in", components: [
    { sku: "2IN-100G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-2IN-100G-3COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "3PACK-125g-2.0in", components: [
    { sku: "2IN-125G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-2IN-125G-3COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "3PACK-100g-2.3in", components: [
    { sku: "23IN-100G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-23IN-100G-3COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "3PACK-125g-2.3in", components: [
    { sku: "23IN-125G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-23IN-125G-3COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},

  // Titanium 2-Pack
  { parent: "TI-2PACK-125g-2.0in", components: [
    { sku: "TI-2IN-125G-BEAST", qty: 2 },
    { sku: "PT-125G", qty: 1 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-TI-2IN-125G-2COUNT", qty: 1 },
    { sku: "TI-BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},

  // Titanium 3-Packs
  { parent: "TI-3PACK-125g-2.0in", components: [
    { sku: "TI-2IN-125G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-TI-2IN-125G-3COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "TI-3PACK-125g-2.3in", components: [
    { sku: "TI-23IN-125G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-TI-23IN-125G-3COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "TI-3PACK-100g-2.0in", components: [
    { sku: "TI-2IN-100G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-TI-2IN-100G-3COUNT", qty: 1 },
    { sku: "TI-BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "TI-3PACK-100g-2.3in", components: [
    { sku: "TI-23IN-100G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-TI-23IN-100G-3COUNT", qty: 1 },
    { sku: "TI-BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},

  // D6 3-Packs
  { parent: "D6-3PACK-2IN-100G", components: [
    { sku: "D6-2IN-100G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-D6-2IN-100G-3COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "D6-3PACK-2IN-125G", components: [
    { sku: "D6-2IN-125G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-D6-2IN-125G-3COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "D6-3PACK-23IN-100G", components: [
    { sku: "D6-23IN-100G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-D6-23IN-100G-3COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "D6-3PACK-23IN-125G", components: [
    { sku: "D6-23IN-125G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-D6-23IN-125G-3COUNT", qty: 1 },
    { sku: "BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},

  // Trump 3-Packs
  { parent: "TR-3PACK-2IN-100G", components: [
    { sku: "TR-2IN-100G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-TR-2IN-100G-3COUNT", qty: 1 },
    { sku: "TR-BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "TR-3PACK-2IN-125G", components: [
    { sku: "TR-2IN-125G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-TR-2IN-125G-3COUNT", qty: 1 },
    { sku: "TR-BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "TR-3PACK-23IN-100G", components: [
    { sku: "TR-23IN-100G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-TR-23IN-100G-3COUNT", qty: 1 },
    { sku: "TR-BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "TR-3PACK-23IN-125G", components: [
    { sku: "TR-23IN-125G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-TR-23IN-125G-3COUNT", qty: 1 },
    { sku: "TR-BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},

  // Steel 3-Pack
  { parent: "ST-3PACK-2IN-150G", components: [
    { sku: "ST-2IN-150G-BEAST", qty: 3 },
    { sku: "BEAST-INSERT", qty: 1 },
    { sku: "BACKER-ST-2IN-150G-3COUNT", qty: 1 },
    { sku: "ST-BACKER-INSERT", qty: 1 },
    { sku: "BEAST-CLAMSHELL", qty: 1 },
  ]},

  // Practice Tip Packs
  { parent: "PT-100G-BEAST", components: [
    { sku: "PT-100G", qty: 3 },
    { sku: "BACKER-PT-100G-3COUNT", qty: 1 },
    { sku: "PT-BEAST-CLAMSHELL", qty: 1 },
  ]},
  { parent: "PT-125G-BEAST", components: [
    { sku: "PT-125G", qty: 3 },
    { sku: "BACKER-PT-125G-3COUNT", qty: 1 },
    { sku: "PT-BEAST-CLAMSHELL", qty: 1 },
  ]},
];

// ============================================
// SEED FUNCTION
// ============================================

async function main() {
  console.log("🌱 Starting seed...");

  // Create admin user
  const hashedPassword = await bcrypt.hash("admin123", 10);
  const adminUser = await prisma.user.upsert({
    where: { email: "admin@beast.com" },
    update: {},
    create: {
      email: "admin@beast.com",
      password: hashedPassword,
      firstName: "Admin",
      lastName: "User",
      role: "ADMIN" as UserRole,
    },
  });
  console.log(`✅ Created admin user: ${adminUser.email}`);

  // Create worker user
  const workerUser = await prisma.user.upsert({
    where: { email: "worker@beast.com" },
    update: {},
    create: {
      email: "worker@beast.com",
      password: hashedPassword,
      firstName: "Worker",
      lastName: "User",
      role: "WORKER" as UserRole,
    },
  });
  console.log(`✅ Created worker user: ${workerUser.email}`);

  // Create all SKUs
  console.log(`\n📦 Creating ${skuData.length} SKUs...`);
  const skuMap = new Map<string, string>(); // sku code -> id

  for (const sku of skuData) {
    const category = inferCategory(sku.sku, sku.name);
    const material = inferMaterial(sku.sku, sku.name);
    const titleCaseName = toTitleCase(sku.name);

    const created = await prisma.sku.upsert({
      where: { sku: sku.sku },
      update: {
        name: titleCaseName,
        type: sku.type,
        category,
        material,
      },
      create: {
        sku: sku.sku,
        name: titleCaseName,
        type: sku.type,
        category,
        material,
      },
    });
    skuMap.set(sku.sku, created.id);
  }
  console.log(`✅ Created ${skuData.length} SKUs`);

  // Create BOM relationships
  console.log(`\n🔗 Creating ${bomData.length} BOM entries...`);
  let bomCount = 0;

  for (const bom of bomData) {
    const parentId = skuMap.get(bom.parent);
    if (!parentId) {
      console.warn(`⚠️  Parent SKU not found: ${bom.parent}`);
      continue;
    }

    for (const component of bom.components) {
      const componentId = skuMap.get(component.sku);
      if (!componentId) {
        console.warn(`⚠️  Component SKU not found: ${component.sku} (for parent ${bom.parent})`);
        continue;
      }

      await prisma.bomComponent.upsert({
        where: {
          parentSkuId_componentSkuId: {
            parentSkuId: parentId,
            componentSkuId: componentId,
          },
        },
        update: { quantity: component.qty },
        create: {
          parentSkuId: parentId,
          componentSkuId: componentId,
          quantity: component.qty,
        },
      });
      bomCount++;
    }
  }
  console.log(`✅ Created ${bomCount} BOM relationships`);

  // Summary
  const rawCount = skuData.filter(s => s.type === "RAW").length;
  const assemblyCount = skuData.filter(s => s.type === "ASSEMBLY").length;
  const completedCount = skuData.filter(s => s.type === "COMPLETED").length;

  console.log(`\n📊 Summary:`);
  console.log(`   Raw Materials: ${rawCount}`);
  console.log(`   Assemblies: ${assemblyCount}`);
  console.log(`   Completed Units: ${completedCount}`);
  console.log(`   BOM Relationships: ${bomCount}`);

  // ============================================
  // CREATE PROCESS CONFIGURATIONS
  // ============================================
  console.log("\n⚙️ Creating process configurations...");

  const processConfigs = [
    { processName: "TIPPING", displayName: "Tipping", description: "Tip installation process", secondsPerUnit: 30, processOrder: 1 },
    { processName: "BLADING", displayName: "Blading", description: "Blade installation process", secondsPerUnit: 45, processOrder: 2 },
    { processName: "STUD_TESTING", displayName: "Stud Testing", description: "Stud test and quality check", secondsPerUnit: 60, processOrder: 3 },
    { processName: "COMPLETE_PACKS", displayName: "Complete Packs", description: "Final packaging process", secondsPerUnit: 90, processOrder: 4 },
  ];

  for (const config of processConfigs) {
    await prisma.processConfig.upsert({
      where: { processName: config.processName },
      update: {
        displayName: config.displayName,
        description: config.description,
        secondsPerUnit: config.secondsPerUnit,
        processOrder: config.processOrder,
      },
      create: config,
    });
  }
  console.log(`✅ Created/updated ${processConfigs.length} process configurations`);

  // ============================================
  // SET PROCESS AND CATEGORY VALUES
  // ============================================
  console.log("\n📋 Setting process and category values...");

  // Process = Column B from CSV (Tipped, Bladed, Stud Tested, Completed Packs)
  // Category = Column C from CSV (Titanium, Aluminum, Steel, TRUMP, etc.)
  const skuProcessCategory: { sku: string; process: string; category: string }[] = [
    { sku: "TI-100-TIPPED-FERRULE", process: "Tipped", category: "Titanium (100g)" },
    { sku: "TI-2IN-100G-BLADED-FERRULE", process: "Bladed", category: "Titanium (100g)" },
    { sku: "TI-2IN-100G-BEAST", process: "Stud Tested", category: "Titanium (100g)" },
    { sku: "TI-3PACK-100g-2.0in", process: "Completed Packs", category: "Titanium (100g)" },
    { sku: "TI-23IN-100G-BLADED-FERRULE", process: "Bladed", category: "Titanium (100g)" },
    { sku: "TI-23IN-100G-BEAST", process: "Stud Tested", category: "Titanium (100g)" },
    { sku: "TI-3PACK-100g-2.3in", process: "Completed Packs", category: "Titanium (100g)" },
    { sku: "TI-TIPPED-FERRULE", process: "Tipped", category: "Titanium (125g)" },
    { sku: "TI-2IN-BLADED-FERRULE", process: "Bladed", category: "Titanium (125g)" },
    { sku: "TI-2IN-125G-BEAST", process: "Stud Tested", category: "Titanium (125g)" },
    { sku: "TI-2PACK-125g-2.0in", process: "Completed Packs", category: "Titanium (125g)" },
    { sku: "TI-3PACK-125g-2.0in", process: "Completed Packs", category: "Titanium (125g)" },
    { sku: "TI-23IN-BLADED-FERRULE", process: "Bladed", category: "Titanium (125g)" },
    { sku: "TI-23IN-125G-BEAST", process: "Stud Tested", category: "Titanium (125g)" },
    { sku: "TI-3PACK-125g-2.3in", process: "Completed Packs", category: "Titanium (125g)" },
    { sku: "TIPPED-FERRULE", process: "Tipped", category: "Aluminum" },
    { sku: "23IN-BLADED-FERRULE", process: "Bladed", category: "Aluminum" },
    { sku: "23IN-100G-BEAST", process: "Stud Tested", category: "Aluminum" },
    { sku: "2PACK-100g-2.3in", process: "Completed Packs", category: "Aluminum" },
    { sku: "3PACK-100g-2.3in", process: "Completed Packs", category: "Aluminum" },
    { sku: "23IN-125G-BEAST", process: "Stud Tested", category: "Aluminum" },
    { sku: "2PACK-125g-2.3in", process: "Completed Packs", category: "Aluminum" },
    { sku: "3PACK-125g-2.3in", process: "Completed Packs", category: "Aluminum" },
    { sku: "D6-23IN-100G-BEAST", process: "Stud Tested", category: "Aluminum" },
    { sku: "D6-3PACK-100g-2.3in", process: "Completed Packs", category: "Aluminum" },
    { sku: "D6-23IN-125G-BEAST", process: "Stud Tested", category: "Aluminum" },
    { sku: "D6-3PACK-125g-2.3in", process: "Completed Packs", category: "Aluminum" },
    { sku: "2IN-BLADED-FERRULE", process: "Bladed", category: "Aluminum" },
    { sku: "2IN-100G-BEAST", process: "Stud Tested", category: "Aluminum" },
    { sku: "2PACK-100g-2.0in", process: "Completed Packs", category: "Aluminum" },
    { sku: "3PACK-100g-2.0in", process: "Completed Packs", category: "Aluminum" },
    { sku: "2IN-125G-BEAST", process: "Stud Tested", category: "Aluminum" },
    { sku: "2PACK-125g-2.0in", process: "Completed Packs", category: "Aluminum" },
    { sku: "3PACK-125g-2.0in", process: "Completed Packs", category: "Aluminum" },
    { sku: "D6-2IN-100G-BEAST", process: "Stud Tested", category: "Aluminum" },
    { sku: "D6-3PACK-100g-2.0in", process: "Completed Packs", category: "Aluminum" },
    { sku: "D6-2IN-125G-BEAST", process: "Stud Tested", category: "Aluminum" },
    { sku: "D6-3PACK-125g-2.0in", process: "Completed Packs", category: "Aluminum" },
    { sku: "ST-TIPPED-FERRULE", process: "Tipped", category: "Steel" },
    { sku: "ST-2IN-BLADED-FERRULE", process: "Bladed", category: "Steel" },
    { sku: "ST-2IN-150G-BEAST", process: "Stud Tested", category: "Steel" },
    { sku: "3PACK-150g-2.0in", process: "Completed Packs", category: "Steel" },
    { sku: "TR-TIPPED-FERRULE", process: "Tipped", category: "TRUMP" },
    { sku: "TR-2IN-BLADED-FERRULE", process: "Bladed", category: "TRUMP" },
    { sku: "TR-2IN-100G-BEAST", process: "Stud Tested", category: "TRUMP" },
    { sku: "TR-2IN-125G-BEAST", process: "Stud Tested", category: "TRUMP" },
    { sku: "TR-23IN-BLADED-FERRULE", process: "Bladed", category: "TRUMP" },
    { sku: "TR-23IN-100G-BEAST", process: "Stud Tested", category: "TRUMP" },
    { sku: "TR-23IN-125G-BEAST", process: "Stud Tested", category: "TRUMP" },
    { sku: "3PACK-PT-100G", process: "Completed Packs", category: "PRACTICE TIPS" },
    { sku: "3PACK-PT-125G", process: "Completed Packs", category: "PRACTICE TIPS" },
  ];

  let processCategoryCount = 0;
  for (const item of skuProcessCategory) {
    const result = await prisma.sku.updateMany({
      where: { sku: item.sku },
      data: {
        material: item.process,   // "material" field stores Process
        category: item.category,  // "category" field stores Category
      },
    });
    if (result.count > 0) processCategoryCount++;
  }
  console.log(`✅ Set process and category for ${processCategoryCount} SKUs`);

  // ============================================
  // SET PROCESS ORDERS
  // ============================================
  console.log("\n📋 Setting process orders...");

  const processOrders: Record<string, number> = {
    "TI-100-TIPPED-FERRULE": 1,
    "TI-2IN-100G-BLADED-FERRULE": 2,
    "TI-2IN-100G-BEAST": 3,
    "TI-3PACK-100g-2.0in": 4,
    "TI-23IN-100G-BLADED-FERRULE": 5,
    "TI-23IN-100G-BEAST": 6,
    "TI-3PACK-100g-2.3in": 7,
    "TI-TIPPED-FERRULE": 8,
    "TI-2IN-BLADED-FERRULE": 9,
    "TI-2IN-125G-BEAST": 10,
    "TI-2PACK-125g-2.0in": 11,
    "TI-3PACK-125g-2.0in": 12,
    "TI-23IN-BLADED-FERRULE": 13,
    "TI-23IN-125G-BEAST": 14,
    "TI-3PACK-125g-2.3in": 15,
    "TIPPED-FERRULE": 16,
    "23IN-BLADED-FERRULE": 17,
    "23IN-100G-BEAST": 18,
    "2PACK-100g-2.3in": 19,
    "3PACK-100g-2.3in": 20,
    "23IN-125G-BEAST": 21,
    "2PACK-125g-2.3in": 22,
    "3PACK-125g-2.3in": 23,
    "D6-23IN-100G-BEAST": 24,
    "D6-3PACK-100g-2.3in": 25,
    "D6-23IN-125G-BEAST": 26,
    "D6-3PACK-125g-2.3in": 27,
    "2IN-BLADED-FERRULE": 28,
    "2IN-100G-BEAST": 29,
    "2PACK-100g-2.0in": 30,
    "3PACK-100g-2.0in": 31,
    "2IN-125G-BEAST": 32,
    "2PACK-125g-2.0in": 33,
    "3PACK-125g-2.0in": 34,
    "D6-2IN-100G-BEAST": 35,
    "D6-3PACK-100g-2.0in": 36,
    "D6-2IN-125G-BEAST": 37,
    "D6-3PACK-125g-2.0in": 38,
    "ST-TIPPED-FERRULE": 39,
    "ST-2IN-BLADED-FERRULE": 40,
    "ST-2IN-150G-BEAST": 41,
    "3PACK-150g-2.0in": 42,
    "TR-TIPPED-FERRULE": 43,
    "TR-2IN-BLADED-FERRULE": 44,
    "TR-2IN-100G-BEAST": 45,
    "TR-2IN-125G-BEAST": 47,
    "TR-23IN-BLADED-FERRULE": 49,
    "TR-23IN-100G-BEAST": 50,
    "TR-23IN-125G-BEAST": 52,
    "3PACK-PT-100G": 54,
    "3PACK-PT-125G": 55,
  };

  let processOrderCount = 0;
  for (const [skuCode, order] of Object.entries(processOrders)) {
    const result = await prisma.sku.updateMany({
      where: { sku: skuCode },
      data: { processOrder: order },
    });
    if (result.count > 0) processOrderCount++;
  }
  console.log(`✅ Set process orders for ${processOrderCount} SKUs`);

  console.log("\n🎉 Seed completed successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
