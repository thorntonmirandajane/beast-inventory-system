import prisma from "../db.server";
import type { SkuType } from "@prisma/client";

export interface UsedInProduct {
  id: string;
  sku: string;
  name: string;
  type: SkuType;
  quantity: number;
  depth: number;
}

/**
 * Get all products that use a given SKU component (recursively).
 * This finds both direct parents and indirect parents (grandparents, etc.)
 *
 * Example:
 * - SPRING-OUTER is in TIP-ASSEMBLY
 * - TIP-ASSEMBLY is in PACK-COMPLETE
 * - Result: [TIP-ASSEMBLY (depth 0), PACK-COMPLETE (depth 1)]
 */
export async function getUsedInProducts(skuId: string): Promise<UsedInProduct[]> {
  const results: UsedInProduct[] = [];
  const visited = new Set<string>();

  async function traverse(currentSkuId: string, depth: number = 0) {
    // Prevent infinite loops and limit depth
    if (visited.has(currentSkuId) || depth > 10) return;
    visited.add(currentSkuId);

    // Find direct parents (products that use this component)
    const parents = await prisma.bomComponent.findMany({
      where: { componentSkuId: currentSkuId },
      include: {
        parentSku: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
          },
        },
      },
    });

    for (const parent of parents) {
      results.push({
        id: parent.parentSku.id,
        sku: parent.parentSku.sku,
        name: parent.parentSku.name,
        type: parent.parentSku.type,
        quantity: parent.quantity,
        depth,
      });

      // Recursively find parents of this parent
      await traverse(parent.parentSkuId, depth + 1);
    }
  }

  await traverse(skuId);

  // Sort by depth (direct parents first) then by SKU
  return results.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.sku.localeCompare(b.sku);
  });
}

/**
 * Get all components of a product (direct children only, non-recursive)
 */
export async function getComponents(skuId: string) {
  return prisma.bomComponent.findMany({
    where: { parentSkuId: skuId },
    include: {
      componentSku: {
        select: {
          id: true,
          sku: true,
          name: true,
          type: true,
        },
      },
    },
    orderBy: {
      componentSku: {
        sku: "asc",
      },
    },
  });
}

/**
 * Check if a SKU has any BOM components
 */
export async function hasComponents(skuId: string): Promise<boolean> {
  const count = await prisma.bomComponent.count({
    where: { parentSkuId: skuId },
  });
  return count > 0;
}

/**
 * Check if a SKU is used in any other products
 */
export async function isUsedInProducts(skuId: string): Promise<boolean> {
  const count = await prisma.bomComponent.count({
    where: { componentSkuId: skuId },
  });
  return count > 0;
}
