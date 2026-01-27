import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Link, Form, useNavigation } from "react-router";
import { redirect } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { calculateBuildEligibility } from "../utils/inventory.server";
import { getUsedInProducts } from "../utils/bom.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { id } = params;

  const sku = await prisma.sku.findUnique({
    where: { id },
    include: {
      bomComponents: {
        include: {
          componentSku: {
            include: {
              inventoryItems: {
                where: { quantity: { gt: 0 } },
              },
            },
          },
        },
        orderBy: { componentSku: { sku: "asc" } },
      },
      inventoryItems: {
        where: { quantity: { gt: 0 } },
        orderBy: { state: "asc" },
      },
      manufacturers: {
        include: {
          manufacturer: true,
        },
        orderBy: { isPreferred: "desc" },
      },
    },
  });

  if (!sku) {
    throw new Response("SKU not found", { status: 404 });
  }

  // Get all products that use this SKU (recursive)
  const usedInProducts = await getUsedInProducts(id!);

  // Calculate build eligibility if this is a buildable SKU
  let buildEligibility = null;
  if (sku.type !== "RAW" && sku.bomComponents.length > 0) {
    buildEligibility = await calculateBuildEligibility(sku.id);
  }

  // Get inventory totals by state
  // For COMPLETED SKUs, only show COMPLETED state. For ASSEMBLY SKUs, only show ASSEMBLED state.
  const inventoryByState = sku.inventoryItems.reduce(
    (acc, item) => {
      // Filter: For COMPLETED SKUs, ignore ASSEMBLED. For ASSEMBLY SKUs, ignore COMPLETED.
      if (sku.type === "COMPLETED" && item.state === "ASSEMBLED") {
        return acc;
      }
      if (sku.type === "ASSEMBLY" && item.state === "COMPLETED") {
        return acc;
      }

      acc[item.state] = (acc[item.state] || 0) + item.quantity;
      return acc;
    },
    {} as Record<string, number>
  );

  // Get recent receiving records for this SKU
  const recentReceiving = await prisma.receivingRecord.findMany({
    where: { skuId: sku.id },
    orderBy: { receivedAt: "desc" },
    take: 10,
    include: {
      createdBy: true,
    },
  });

  // Get all SKUs for editing BOM
  const allSkus = await prisma.sku.findMany({
    where: { isActive: true, id: { not: sku.id } },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  // Get all manufacturers
  const allManufacturers = await prisma.manufacturer.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  // Get all unique Process values (stored in material field)
  const uniqueProcesses = await prisma.sku.findMany({
    where: { material: { not: null }, isActive: true },
    select: { material: true },
    distinct: ["material"],
    orderBy: { material: "asc" },
  });

  // Get all unique Category values
  const uniqueCategories = await prisma.sku.findMany({
    where: { category: { not: null }, isActive: true },
    select: { category: true },
    distinct: ["category"],
    orderBy: { category: "asc" },
  });

  return {
    user,
    sku,
    buildEligibility,
    inventoryByState,
    usedInProducts,
    recentReceiving,
    allSkus,
    allManufacturers,
    uniqueProcesses: uniqueProcesses.map(p => p.material).filter(Boolean) as string[],
    uniqueCategories: uniqueCategories.map(c => c.category).filter(Boolean) as string[],
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const { id } = params;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "delete") {
    // Check if SKU is used anywhere
    const usedInBom = await prisma.bomComponent.count({ where: { componentSkuId: id } });
    const hasInventory = await prisma.inventoryItem.count({ where: { skuId: id, quantity: { gt: 0 } } });

    if (usedInBom > 0) {
      return { error: "Cannot delete: This SKU is used as a component in other products" };
    }
    if (hasInventory > 0) {
      return { error: "Cannot delete: This SKU has inventory" };
    }

    // Delete BOM components first, then the SKU
    await prisma.bomComponent.deleteMany({ where: { parentSkuId: id } });
    await prisma.sku.delete({ where: { id } });

    await createAuditLog(user.id, "DELETE_SKU", "Sku", id!, {});

    return redirect("/skus");
  }

  if (intent === "update") {
    const name = (formData.get("name") as string)?.trim();
    const description = formData.get("description") as string;
    const isActive = formData.get("isActive") === "true";
    const category = formData.get("category") as string | null;
    const material = formData.get("material") as string | null;
    const upc = formData.get("upc") as string | null;

    if (!name) {
      return { error: "Name is required" };
    }

    // Parse BOM components
    const components: { skuId: string; quantity: number }[] = [];
    let i = 0;
    while (formData.get(`components[${i}][skuId]`)) {
      const componentSkuId = formData.get(`components[${i}][skuId]`) as string;
      const quantity = parseInt(formData.get(`components[${i}][quantity]`) as string, 10);
      if (componentSkuId && quantity > 0) {
        components.push({ skuId: componentSkuId, quantity });
      }
      i++;
    }

    // Update SKU
    await prisma.sku.update({
      where: { id },
      data: {
        name,
        description: description || null,
        isActive,
        category: category || null,
        material: material || null,
        upc: upc || null,
      },
    });

    // Update BOM - delete all and recreate
    await prisma.bomComponent.deleteMany({ where: { parentSkuId: id } });
    if (components.length > 0) {
      await prisma.bomComponent.createMany({
        data: components.map((c) => ({
          parentSkuId: id!,
          componentSkuId: c.skuId,
          quantity: c.quantity,
        })),
      });
    }

    await createAuditLog(user.id, "UPDATE_SKU", "Sku", id!, {
      name,
      isActive,
      componentCount: components.length,
    });

    return { success: true, message: "SKU updated successfully" };
  }

  if (intent === "add-manufacturer") {
    const manufacturerName = (formData.get("manufacturerName") as string)?.trim();
    const existingManufacturerId = formData.get("existingManufacturerId") as string;
    const cost = formData.get("cost") as string;
    const leadTimeDays = formData.get("leadTimeDays") as string;
    const isPreferred = formData.get("isPreferred") === "true";
    const notes = formData.get("notes") as string;

    let manufacturerId = existingManufacturerId;

    // Create new manufacturer if name provided
    if (manufacturerName && !existingManufacturerId) {
      const existing = await prisma.manufacturer.findUnique({
        where: { name: manufacturerName },
      });

      if (existing) {
        manufacturerId = existing.id;
      } else {
        const newManufacturer = await prisma.manufacturer.create({
          data: { name: manufacturerName },
        });
        manufacturerId = newManufacturer.id;
      }
    }

    if (!manufacturerId) {
      return { error: "Please select or create a manufacturer" };
    }

    // Check if already exists
    const existing = await prisma.skuManufacturer.findUnique({
      where: {
        skuId_manufacturerId: {
          skuId: id!,
          manufacturerId,
        },
      },
    });

    if (existing) {
      return { error: "This manufacturer is already added to this SKU" };
    }

    // If this is set as preferred, unset other preferred
    if (isPreferred) {
      await prisma.skuManufacturer.updateMany({
        where: { skuId: id },
        data: { isPreferred: false },
      });
    }

    await prisma.skuManufacturer.create({
      data: {
        skuId: id!,
        manufacturerId,
        cost: cost ? parseFloat(cost) : null,
        leadTimeDays: leadTimeDays ? parseInt(leadTimeDays, 10) : null,
        isPreferred,
        notes: notes || null,
      },
    });

    await createAuditLog(user.id, "ADD_SKU_MANUFACTURER", "SkuManufacturer", id!, {
      manufacturerId,
    });

    return { success: true, message: "Manufacturer added successfully" };
  }

  if (intent === "remove-manufacturer") {
    const skuManufacturerId = formData.get("skuManufacturerId") as string;

    await prisma.skuManufacturer.delete({
      where: { id: skuManufacturerId },
    });

    await createAuditLog(user.id, "REMOVE_SKU_MANUFACTURER", "SkuManufacturer", id!, {
      skuManufacturerId,
    });

    return { success: true, message: "Manufacturer removed" };
  }

  if (intent === "update-manufacturer") {
    const skuManufacturerId = formData.get("skuManufacturerId") as string;
    const cost = formData.get("cost") as string;
    const leadTimeDays = formData.get("leadTimeDays") as string;
    const isPreferred = formData.get("isPreferred") === "true";
    const notes = formData.get("notes") as string;

    // If this is set as preferred, unset other preferred
    if (isPreferred) {
      await prisma.skuManufacturer.updateMany({
        where: { skuId: id, id: { not: skuManufacturerId } },
        data: { isPreferred: false },
      });
    }

    await prisma.skuManufacturer.update({
      where: { id: skuManufacturerId },
      data: {
        cost: cost ? parseFloat(cost) : null,
        leadTimeDays: leadTimeDays ? parseInt(leadTimeDays, 10) : null,
        isPreferred,
        notes: notes || null,
      },
    });

    await createAuditLog(user.id, "UPDATE_SKU_MANUFACTURER", "SkuManufacturer", id!, {
      skuManufacturerId,
    });

    return { success: true, message: "Manufacturer updated" };
  }

  if (intent === "set-inventory") {
    const state = formData.get("state") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);

    if (!state || isNaN(quantity) || quantity < 0) {
      return { error: "Invalid state or quantity" };
    }

    // Find existing inventory item for this state
    const existingItem = await prisma.inventoryItem.findFirst({
      where: { skuId: id, state },
    });

    if (existingItem) {
      if (quantity === 0) {
        // Delete if setting to 0
        await prisma.inventoryItem.delete({
          where: { id: existingItem.id },
        });
      } else {
        // Update existing
        await prisma.inventoryItem.update({
          where: { id: existingItem.id },
          data: { quantity },
        });
      }
    } else if (quantity > 0) {
      // Create new if doesn't exist and quantity > 0
      await prisma.inventoryItem.create({
        data: {
          skuId: id!,
          state,
          quantity,
        },
      });
    }

    await createAuditLog(user.id, "SET_INVENTORY", "InventoryItem", id!, {
      state,
      quantity,
    });

    return { success: true, message: `Inventory for ${state} set to ${quantity}` };
  }

  if (intent === "add-bom-component") {
    const componentSkuId = formData.get("componentSkuId") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);

    if (!componentSkuId || isNaN(quantity) || quantity <= 0) {
      return { error: "Please select a component and provide a valid quantity" };
    }

    // Check if already exists
    const existing = await prisma.bomComponent.findUnique({
      where: {
        parentSkuId_componentSkuId: {
          parentSkuId: id!,
          componentSkuId,
        },
      },
    });

    if (existing) {
      return { error: "This component is already in the BOM" };
    }

    await prisma.bomComponent.create({
      data: {
        parentSkuId: id!,
        componentSkuId,
        quantity,
      },
    });

    await createAuditLog(user.id, "ADD_BOM_COMPONENT", "BomComponent", id!, {
      componentSkuId,
      quantity,
    });

    return { success: true, message: "Component added to BOM" };
  }

  if (intent === "remove-bom-component") {
    const bomComponentId = formData.get("bomComponentId") as string;

    await prisma.bomComponent.delete({
      where: { id: bomComponentId },
    });

    await createAuditLog(user.id, "REMOVE_BOM_COMPONENT", "BomComponent", id!, {
      bomComponentId,
    });

    return { success: true, message: "Component removed from BOM" };
  }

  if (intent === "update-bom-component") {
    const bomComponentId = formData.get("bomComponentId") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);

    if (isNaN(quantity) || quantity <= 0) {
      return { error: "Please provide a valid quantity" };
    }

    await prisma.bomComponent.update({
      where: { id: bomComponentId },
      data: { quantity },
    });

    await createAuditLog(user.id, "UPDATE_BOM_COMPONENT", "BomComponent", id!, {
      bomComponentId,
      quantity,
    });

    return { success: true, message: "Component quantity updated" };
  }

  return { error: "Invalid action" };
};

export default function SkuDetail() {
  const {
    user,
    sku,
    buildEligibility,
    inventoryByState,
    usedInProducts,
    recentReceiving,
    allManufacturers,
    allSkus,
    uniqueProcesses,
    uniqueCategories,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Build current BOM map for form defaults
  const currentBom = new Map(sku.bomComponents.map((b) => [b.componentSku.id, b.quantity]));

  const getTypeColor = (type: string) => {
    switch (type) {
      case "RAW":
        return "bg-gray-100 text-gray-800";
      case "ASSEMBLY":
        return "bg-blue-100 text-blue-800";
      case "COMPLETED":
        return "bg-green-100 text-green-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getStateColor = (state: string) => {
    switch (state) {
      case "RECEIVED":
        return "bg-yellow-100 text-yellow-800";
      case "RAW":
        return "bg-gray-100 text-gray-800";
      case "ASSEMBLED":
        return "bg-blue-100 text-blue-800";
      case "COMPLETED":
        return "bg-green-100 text-green-800";
      case "TRANSFERRED":
        return "bg-purple-100 text-purple-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const totalInventory = Object.values(inventoryByState).reduce(
    (sum, qty) => sum + qty,
    0
  );

  return (
    <Layout user={user}>
      {/* Header */}
      <div className="mb-6">
        <Link to="/skus" className="text-sm text-gray-500 hover:text-gray-700">
          ← Back to SKU Catalog
        </Link>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      <div className="page-header flex justify-between items-start">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="page-title font-mono">{sku.sku}</h1>
            <span className={`badge ${getTypeColor(sku.type)}`}>{sku.type}</span>
            {sku.category && (
              <span className="badge bg-purple-100 text-purple-800">{sku.category.replace("_", " ")}</span>
            )}
            {sku.material && (
              <span className="badge bg-yellow-100 text-yellow-800">{sku.material}</span>
            )}
            {!sku.isActive && (
              <span className="badge bg-red-100 text-red-800">Inactive</span>
            )}
          </div>
          <p className="page-subtitle">{sku.name}</p>
        </div>

        <div className="flex gap-2">
        </div>
      </div>

      {/* Stats Grid */}
      <div className="stats-grid mb-6">
        <div className="stat-card">
          <div className="stat-value">{totalInventory}</div>
          <div className="stat-label">Total Inventory</div>
        </div>
        {buildEligibility && (
          <>
            <div className="stat-card">
              <div
                className={`stat-value ${
                  buildEligibility.maxBuildable > 0
                    ? "text-green-600"
                    : "text-red-600"
                }`}
              >
                {buildEligibility.maxBuildable}
              </div>
              <div className="stat-label">Max Buildable</div>
            </div>
            {buildEligibility.bottleneck && (
              <div className="stat-card">
                <div className="stat-value text-sm font-mono">
                  {buildEligibility.bottleneck.sku}
                </div>
                <div className="stat-label">Bottleneck Component</div>
              </div>
            )}
          </>
        )}
        <div className="stat-card">
          <div className="stat-value">{sku.bomComponents.length}</div>
          <div className="stat-label">Components</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{usedInProducts.length}</div>
          <div className="stat-label">Used In</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inventory by State */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Inventory by State</h2>
          </div>
          <div className="card-body">
            {Object.keys(inventoryByState).length === 0 ? (
              <p className="text-gray-500 mb-4">No inventory for this SKU</p>
            ) : (
              <div className="space-y-3 mb-4">
                {Object.entries(inventoryByState).map(([state, qty]) => (
                  <div
                    key={state}
                    className="flex justify-between items-center p-3 bg-gray-50 rounded-lg"
                  >
                    <span className={`badge ${getStateColor(state)}`}>{state}</span>
                    <span className="font-semibold">{qty}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Note about editing inventory */}
            {user.role === "ADMIN" && (
              <div className="border-t pt-4">
                <p className="text-sm text-gray-500">
                  To adjust inventory quantities, use the <Link to="/inventory" className="text-blue-600 hover:underline">Inventory page</Link> with inline editing.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Bill of Materials */}
        {(sku.type === "ASSEMBLY" || sku.type === "COMPLETED") && (
          <div className="card">
            <div className="card-header flex items-center justify-between">
              <div>
                <h2 className="card-title">Bill of Materials</h2>
                <p className="text-sm text-gray-500">Components needed to build this SKU</p>
              </div>
            </div>
            <div className="card-body">
              {sku.bomComponents.length === 0 ? (
                <div className="text-center text-gray-500 py-4">
                  No components added yet
                </div>
              ) : (
                <table className="data-table mb-4">
                  <thead>
                    <tr>
                      <th>Component SKU</th>
                      <th>Name</th>
                      <th className="text-right">Qty Needed</th>
                      <th className="text-right">Available</th>
                      {user.role === "ADMIN" && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {sku.bomComponents.map((bom) => {
                      const available = bom.componentSku.inventoryItems.reduce(
                        (sum, item) => sum + item.quantity,
                        0
                      );
                      return (
                        <tr key={bom.id}>
                          <td>
                            <Link
                              to={`/skus/${bom.componentSku.id}`}
                              className="font-mono text-sm text-blue-600 hover:underline"
                            >
                              {bom.componentSku.sku}
                            </Link>
                          </td>
                          <td className="max-w-xs truncate text-sm">
                            {bom.componentSku.name}
                          </td>
                          <td className="text-right font-semibold">{bom.quantity}</td>
                          <td
                            className={`text-right font-semibold ${
                              available >= bom.quantity
                                ? "text-green-600"
                                : "text-red-600"
                            }`}
                          >
                            {available}
                          </td>
                          {user.role === "ADMIN" && (
                            <td>
                              <div className="flex items-center gap-2 justify-end">
                                <Form method="post" className="flex items-center gap-2">
                                  <input type="hidden" name="intent" value="update-bom-component" />
                                  <input type="hidden" name="bomComponentId" value={bom.id} />
                                  <input
                                    type="number"
                                    name="quantity"
                                    className="form-input w-20 text-sm"
                                    min="1"
                                    defaultValue={bom.quantity}
                                    required
                                  />
                                  <button
                                    type="submit"
                                    className="btn btn-sm btn-secondary whitespace-nowrap"
                                    disabled={isSubmitting}
                                  >
                                    Update
                                  </button>
                                </Form>
                                <Form method="post">
                                  <input type="hidden" name="intent" value="remove-bom-component" />
                                  <input type="hidden" name="bomComponentId" value={bom.id} />
                                  <button
                                    type="submit"
                                    className="btn btn-sm btn-danger whitespace-nowrap"
                                    disabled={isSubmitting}
                                  >
                                    Remove
                                  </button>
                                </Form>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {/* Add component form */}
              {user.role === "ADMIN" && (
                <Form method="post" className="border-t pt-4">
                  <input type="hidden" name="intent" value="add-bom-component" />
                  <h3 className="font-semibold mb-3">Add Component</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="md:col-span-2">
                      <label htmlFor="componentSkuId" className="form-label">
                        Component SKU
                      </label>
                      <input
                        type="text"
                        id="componentSkuId"
                        name="componentSkuId"
                        className="form-input"
                        list="component-sku-options"
                        placeholder="Type to search..."
                        required
                      />
                      <datalist id="component-sku-options">
                        {allSkus.map((s) => (
                          <option key={s.id} value={s.id} label={`${s.sku} | ${s.name} (${s.type})`} />
                        ))}
                      </datalist>
                    </div>
                    <div>
                      <label htmlFor="bom-quantity" className="form-label">
                        Quantity
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          id="bom-quantity"
                          name="quantity"
                          className="form-input flex-1"
                          min="1"
                          required
                        />
                        <button
                          type="submit"
                          className="btn btn-primary"
                          disabled={isSubmitting}
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  </div>
                </Form>
              )}
            </div>
          </div>
        )}

        {/* Manufacturers */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <div>
              <h2 className="card-title">Manufacturers</h2>
              <p className="text-sm text-gray-500">Suppliers for this SKU with cost and lead time</p>
            </div>
          </div>
          <div className="card-body">
            {sku.manufacturers.length === 0 ? (
              <div className="text-center text-gray-500 py-4">
                No manufacturers added yet
              </div>
            ) : (
              <table className="data-table mb-4">
                <thead>
                  <tr>
                    <th>Manufacturer</th>
                    <th className="text-right">Cost/Unit</th>
                    <th className="text-right">Lead Time</th>
                    <th>Preferred</th>
                    <th>Notes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sku.manufacturers.map((sm) => (
                    <tr key={sm.id}>
                      <td className="font-semibold">{sm.manufacturer.name}</td>
                      <td className="text-right">
                        {sm.cost ? `$${sm.cost.toFixed(2)}` : "—"}
                      </td>
                      <td className="text-right">
                        {sm.leadTimeDays ? `${sm.leadTimeDays} days` : "—"}
                      </td>
                      <td>
                        {sm.isPreferred && (
                          <span className="badge bg-green-100 text-green-700">
                            Preferred
                          </span>
                        )}
                      </td>
                      <td className="text-sm text-gray-500 max-w-xs truncate">
                        {sm.notes || "—"}
                      </td>
                      <td>
                        <Form method="post">
                          <input type="hidden" name="intent" value="remove-manufacturer" />
                          <input type="hidden" name="skuManufacturerId" value={sm.id} />
                          <button
                            type="submit"
                            className="text-red-600 hover:text-red-800 text-sm"
                          >
                            Remove
                          </button>
                        </Form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Add Manufacturer Form */}
            <div className="border-t pt-4">
              <h3 className="font-semibold mb-3">Add Manufacturer</h3>
              <Form method="post" className="space-y-3">
                <input type="hidden" name="intent" value="add-manufacturer" />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="form-group">
                    <label className="form-label">Select Existing</label>
                    <select name="existingManufacturerId" className="form-select">
                      <option value="">— Or create new below —</option>
                      {allManufacturers.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Or Create New</label>
                    <input
                      type="text"
                      name="manufacturerName"
                      className="form-input"
                      placeholder="New manufacturer name"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Cost Per Unit ($)</label>
                    <input
                      type="number"
                      name="cost"
                      step="0.01"
                      className="form-input"
                      placeholder="0.00"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Lead Time (days)</label>
                    <input
                      type="number"
                      name="leadTimeDays"
                      className="form-input"
                      placeholder="30"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Notes</label>
                    <input
                      type="text"
                      name="notes"
                      className="form-input"
                      placeholder="Optional notes"
                    />
                  </div>
                  <div className="form-group flex items-center">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name="isPreferred"
                        value="true"
                        className="form-checkbox"
                      />
                      <span>Mark as Preferred</span>
                    </label>
                  </div>
                </div>
                <button type="submit" className="btn btn-primary">
                  Add Manufacturer
                </button>
              </Form>
            </div>
          </div>
        </div>

        {/* Used In */}
        {usedInProducts.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Used In</h2>
              <p className="text-sm text-gray-500">All products that use this SKU (including indirect)</p>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Parent SKU</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="text-right">Qty Per</th>
                </tr>
              </thead>
              <tbody>
                {usedInProducts.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <Link
                        to={`/skus/${product.id}`}
                        className="font-mono text-sm text-blue-600 hover:underline"
                        style={{ paddingLeft: `${product.depth * 20}px` }}
                      >
                        {product.depth > 0 && "└─ "}
                        {product.sku}
                      </Link>
                    </td>
                    <td className="max-w-xs truncate text-sm">
                      {product.name}
                    </td>
                    <td>
                      <span className={`badge ${getTypeColor(product.type)}`}>
                        {product.type}
                      </span>
                    </td>
                    <td className="text-right font-semibold">{product.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Recent Receiving */}
        {recentReceiving.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Recent Receiving</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Quantity</th>
                  <th>Status</th>
                  <th>PO #</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {recentReceiving.map((rec) => (
                  <tr key={rec.id}>
                    <td className="font-semibold">{rec.quantity}</td>
                    <td>
                      <span
                        className={`badge ${
                          rec.status === "APPROVED"
                            ? "status-approved"
                            : rec.status === "REJECTED"
                            ? "status-rejected"
                            : "status-pending"
                        }`}
                      >
                        {rec.status}
                      </span>
                    </td>
                    <td>{rec.poNumber || "—"}</td>
                    <td>{new Date(rec.receivedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit SKU Form */}
      {user.role === "ADMIN" && (
        <div className="card mt-6">
          <div className="card-header">
            <h2 className="card-title">Edit SKU</h2>
          </div>
          <div className="card-body">
            <Form method="post">
              <input type="hidden" name="intent" value="update" />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div className="form-group">
                  <label className="form-label">SKU Code</label>
                  <input
                    type="text"
                    className="form-input font-mono bg-gray-100"
                    value={sku.sku}
                    disabled
                  />
                  <p className="text-sm text-gray-500 mt-1">SKU code cannot be changed</p>
                </div>
                {sku.type === "COMPLETED" ? (
                  <div className="form-group">
                    <label className="form-label">UPC Code</label>
                    <input
                      type="text"
                      name="upc"
                      className="form-input font-mono"
                      defaultValue={sku.upc || ""}
                      placeholder="Enter UPC code..."
                    />
                    <p className="text-sm text-gray-500 mt-1">Optional barcode for completed products</p>
                  </div>
                ) : null}
                <div className="form-group">
                  <label className="form-label">Status</label>
                  <select name="isActive" className="form-select" defaultValue={sku.isActive.toString()}>
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                  </select>
                </div>
                <div className="form-group md:col-span-2">
                  <label className="form-label">Name *</label>
                  <input
                    type="text"
                    name="name"
                    className="form-input"
                    required
                    defaultValue={sku.name}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Process</label>
                  <input
                    type="text"
                    name="material"
                    className="form-input"
                    placeholder="e.g., Tipped, Bladed, Stud Tested"
                    defaultValue={sku.material || ""}
                    list="process-options"
                  />
                  <datalist id="process-options">
                    {uniqueProcesses.map((process) => (
                      <option key={process} value={process} />
                    ))}
                  </datalist>
                  <p className="text-xs text-gray-500 mt-1">
                    Select from existing or type a new value
                  </p>
                </div>
                <div className="form-group">
                  <label className="form-label">Category</label>
                  <input
                    type="text"
                    name="category"
                    className="form-input"
                    placeholder="e.g., Aluminum, Titanium (100g)"
                    defaultValue={sku.category || ""}
                    list="category-options"
                  />
                  <datalist id="category-options">
                    {uniqueCategories.map((category) => (
                      <option key={category} value={category} />
                    ))}
                  </datalist>
                  <p className="text-xs text-gray-500 mt-1">
                    Select from existing or type a new value
                  </p>
                </div>
                <div className="form-group md:col-span-2">
                  <label className="form-label">Description</label>
                  <textarea
                    name="description"
                    className="form-textarea"
                    rows={2}
                    defaultValue={sku.description || ""}
                  />
                </div>
              </div>

              {sku.type !== "RAW" && (
                <div className="mb-4">
                  <label className="form-label">Bill of Materials</label>
                  <p className="text-sm text-gray-500 mb-3">
                    Set quantity to 0 to remove a component
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-96 overflow-y-auto border border-gray-200 rounded-lg p-3">
                    {allSkus.map((s, index) => (
                      <div
                        key={s.id}
                        className={`flex items-center gap-3 p-3 rounded border ${
                          s.type === "RAW"
                            ? "bg-gray-50 border-gray-200"
                            : "bg-blue-50 border-blue-200"
                        }`}
                      >
                        <input type="hidden" name={`components[${index}][skuId]`} value={s.id} />
                        <div className="flex-1 overflow-hidden">
                          <div className="font-mono text-sm font-semibold text-gray-900 mb-1">
                            {s.sku}
                          </div>
                          <div className="text-xs text-gray-600 line-clamp-2">
                            {s.name}
                          </div>
                        </div>
                        <input
                          type="number"
                          name={`components[${index}][quantity]`}
                          className="form-input w-20 text-sm flex-shrink-0"
                          min="0"
                          defaultValue={currentBom.get(s.id) || 0}
                          placeholder="Qty"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Delete SKU */}
      {user.role === "ADMIN" && (
        <div className="card mt-6 border-red-200">
          <div className="card-header bg-red-50">
            <h2 className="card-title text-red-800">Danger Zone</h2>
          </div>
          <div className="card-body">
            <p className="text-sm text-gray-600 mb-4">
              Deleting a SKU is permanent. You can only delete SKUs that:
            </p>
            <ul className="list-disc list-inside text-sm text-gray-600 mb-4">
              <li>Are not used as a component in other products</li>
              <li>Have no inventory</li>
            </ul>
            <Form method="post" onSubmit={(e) => {
              if (!confirm(`Are you sure you want to delete ${sku.sku}? This cannot be undone.`)) {
                e.preventDefault();
              }
            }}>
              <input type="hidden" name="intent" value="delete" />
              <button
                type="submit"
                className="btn bg-red-600 text-white hover:bg-red-700"
                disabled={isSubmitting}
              >
                Delete SKU
              </button>
            </Form>
          </div>
        </div>
      )}
    </Layout>
  );
}
