import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, Link, useNavigation } from "react-router";
import { redirect } from "react-router";
import { useState } from "react";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Get all SKUs for component selection
  const allSkus = await prisma.sku.findMany({
    where: { isActive: true },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  // Get all active process configurations
  const activeProcesses = await prisma.processConfig.findMany({
    where: { isActive: true },
    select: { processName: true, displayName: true },
    orderBy: { displayName: "asc" },
  });

  // Get all unique categories from existing SKUs
  const uniqueCategories = await prisma.sku.findMany({
    where: { category: { not: null }, isActive: true },
    select: { category: true },
    distinct: ["category"],
    orderBy: { category: "asc" },
  });

  const categories = uniqueCategories.map(s => s.category).filter((c): c is string => c !== null);

  return { user, allSkus, activeProcesses, categories };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();

  const sku = (formData.get("sku") as string)?.trim().toUpperCase();
  const name = (formData.get("name") as string)?.trim().toUpperCase();
  const type = formData.get("type") as "RAW" | "ASSEMBLY" | "COMPLETED";
  const description = formData.get("description") as string;
  const category = formData.get("category") as string | null;
  const material = formData.get("material") as string | null;
  const processOrderStr = formData.get("processOrder") as string | null;
  const processOrder = processOrderStr ? parseInt(processOrderStr, 10) : null;

  if (!sku || !name || !type) {
    return { error: "SKU, NAME, AND TYPE ARE REQUIRED" };
  }

  // Check if SKU already exists
  const existing = await prisma.sku.findUnique({ where: { sku } });
  if (existing) {
    return { error: `SKU "${sku}" ALREADY EXISTS` };
  }

  // Parse BOM components from JSON
  const componentsJson = formData.get("componentsJson") as string;
  const components: { skuId: string; quantity: number }[] = componentsJson
    ? JSON.parse(componentsJson)
    : [];

  // Create SKU with BOM
  const newSku = await prisma.sku.create({
    data: {
      sku,
      name,
      type,
      description: description?.toUpperCase() || null,
      category: category || null,
      material: material || null,
      processOrder: processOrder,
      bomComponents: {
        create: components.map((c) => ({
          componentSkuId: c.skuId,
          quantity: c.quantity,
        })),
      },
    },
  });

  await createAuditLog(user.id, "CREATE_SKU", "Sku", newSku.id, {
    sku,
    name,
    type,
    componentCount: components.length,
  });

  return redirect(`/skus/${newSku.id}`);
};

interface SelectedComponent {
  skuId: string;
  sku: string;
  name: string;
  type: string;
  quantity: number;
}

export default function NewSku() {
  const { user, allSkus, activeProcesses, categories } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [selectedType, setSelectedType] = useState<string>("");
  const [selectedComponents, setSelectedComponents] = useState<SelectedComponent[]>([]);
  const [searchTerm, setSearchTerm] = useState("");

  const rawSkus = allSkus.filter((s) => s.type === "RAW");
  const assemblySkus = allSkus.filter((s) => s.type === "ASSEMBLY");

  // Filter available components based on search
  const availableComponents = allSkus.filter((s) => {
    // Don't show completed products as components
    if (s.type === "COMPLETED") return false;
    // Don't show already selected
    if (selectedComponents.some((sc) => sc.skuId === s.id)) return false;
    // Apply search filter
    if (searchTerm) {
      const search = searchTerm.toUpperCase();
      return s.sku.toUpperCase().includes(search) || s.name.toUpperCase().includes(search);
    }
    return true;
  });

  const addComponent = (sku: typeof allSkus[0]) => {
    setSelectedComponents([
      ...selectedComponents,
      {
        skuId: sku.id,
        sku: sku.sku,
        name: sku.name,
        type: sku.type,
        quantity: 1,
      },
    ]);
    setSearchTerm("");
  };

  const updateQuantity = (skuId: string, quantity: number) => {
    setSelectedComponents(
      selectedComponents.map((c) =>
        c.skuId === skuId ? { ...c, quantity: Math.max(1, quantity) } : c
      )
    );
  };

  const removeComponent = (skuId: string) => {
    setSelectedComponents(selectedComponents.filter((c) => c.skuId !== skuId));
  };

  return (
    <Layout user={user}>
      <div className="mb-6">
        <Link to="/skus" className="text-sm text-gray-500 hover:text-gray-700">
          ← BACK TO SKU CATALOG
        </Link>
      </div>

      <div className="page-header">
        <h1 className="page-title">CREATE NEW SKU</h1>
        <p className="page-subtitle">ADD A NEW PRODUCT OR COMPONENT TO THE CATALOG</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}

      <Form method="post">
        {/* Hidden field for components */}
        <input
          type="hidden"
          name="componentsJson"
          value={JSON.stringify(
            selectedComponents.map((c) => ({ skuId: c.skuId, quantity: c.quantity }))
          )}
        />

        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">BASIC INFORMATION</h2>
          </div>
          <div className="card-body">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group">
                <label className="form-label">SKU CODE *</label>
                <input
                  type="text"
                  name="sku"
                  className="form-input font-mono uppercase"
                  required
                  placeholder="E.G., FERRULE-100G"
                />
                <p className="text-sm text-gray-500 mt-1">
                  UNIQUE IDENTIFIER FOR THIS PRODUCT
                </p>
              </div>
              <div className="form-group">
                <label className="form-label">TYPE *</label>
                <select
                  name="type"
                  className="form-select"
                  required
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                >
                  <option value="">SELECT TYPE...</option>
                  <option value="RAW">RAW MATERIAL</option>
                  <option value="ASSEMBLY">ASSEMBLY (INTERMEDIATE)</option>
                  <option value="COMPLETED">COMPLETED PRODUCT</option>
                </select>
                <p className="text-sm text-gray-500 mt-1">
                  RAW = PURCHASED, ASSEMBLY = BUILT INTERMEDIATE, COMPLETED = FINAL PRODUCT
                </p>
              </div>
              <div className="form-group md:col-span-2">
                <label className="form-label">NAME *</label>
                <input
                  type="text"
                  name="name"
                  className="form-input uppercase"
                  required
                  placeholder="E.G., TITANIUM FERRULE - 100 GRAIN"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Process</label>
                <select name="material" className="form-select">
                  <option value="">No process</option>
                  {activeProcesses.map((process) => (
                    <option key={process.processName} value={process.processName}>
                      {process.displayName}
                    </option>
                  ))}
                </select>
                <p className="text-sm text-gray-500 mt-1">
                  Which process step this SKU is used in
                </p>
              </div>
              <div className="form-group">
                <label className="form-label">Category</label>
                <select name="category" className="form-select">
                  <option value="">No category</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
                <p className="text-sm text-gray-500 mt-1">
                  Product category for organization (e.g., Tips, Blades, etc.)
                </p>
              </div>
              <div className="form-group">
                <label className="form-label">Process Order</label>
                <input
                  type="number"
                  name="processOrder"
                  className="form-input"
                  placeholder="E.G., 1, 2, 3..."
                  min="1"
                  step="1"
                />
                <p className="text-sm text-gray-500 mt-1">
                  Workflow sequence number for this SKU
                </p>
              </div>
              <div className="form-group md:col-span-2">
                <label className="form-label">DESCRIPTION</label>
                <textarea
                  name="description"
                  className="form-textarea uppercase"
                  rows={2}
                  placeholder="OPTIONAL DESCRIPTION..."
                />
              </div>
            </div>
          </div>
        </div>

        {/* BOM Section - only show for non-RAW types */}
        {selectedType && selectedType !== "RAW" && (
          <div className="card mb-6">
            <div className="card-header">
              <h2 className="card-title">BILL OF MATERIALS (BOM)</h2>
              <p className="text-sm text-gray-500">
                SPECIFY WHAT COMPONENTS ARE NEEDED TO BUILD ONE UNIT
              </p>
            </div>
            <div className="card-body">
              {/* Selected Components */}
              {selectedComponents.length > 0 && (
                <div className="mb-6">
                  <h3 className="font-medium text-gray-700 mb-3">SELECTED COMPONENTS</h3>
                  <div className="space-y-2">
                    {selectedComponents.map((comp) => (
                      <div
                        key={comp.skuId}
                        className={`flex items-center justify-between p-3 rounded border ${
                          comp.type === "RAW"
                            ? "bg-gray-50 border-gray-200"
                            : "bg-blue-50 border-blue-200"
                        }`}
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold">
                              {comp.sku.toUpperCase()}
                            </span>
                            <span
                              className={`badge text-xs ${
                                comp.type === "RAW"
                                  ? "bg-gray-200 text-gray-700"
                                  : "bg-blue-200 text-blue-700"
                              }`}
                            >
                              {comp.type}
                            </span>
                          </div>
                          <div className="text-sm text-gray-500">
                            {comp.name.toUpperCase()}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-gray-500">QTY:</span>
                            <input
                              type="number"
                              value={comp.quantity}
                              onChange={(e) =>
                                updateQuantity(comp.skuId, parseInt(e.target.value, 10))
                              }
                              className="form-input w-20 text-center"
                              min="1"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => removeComponent(comp.skuId)}
                            className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                          >
                            <svg
                              className="w-5 h-5"
                              fill="none"
                              viewBox="0 0 24 24"
                              strokeWidth={1.5}
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Add Components */}
              <div>
                <h3 className="font-medium text-gray-700 mb-3">ADD COMPONENTS</h3>

                {/* Search */}
                <div className="mb-4">
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="form-input uppercase"
                    placeholder="SEARCH BY SKU OR NAME..."
                  />
                </div>

                {/* Available Components Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 max-h-64 overflow-y-auto">
                  {availableComponents.map((sku) => (
                    <button
                      key={sku.id}
                      type="button"
                      onClick={() => addComponent(sku)}
                      className={`flex items-center gap-2 p-2 text-left rounded border hover:border-blue-400 transition-colors ${
                        sku.type === "RAW"
                          ? "bg-gray-50 border-gray-200"
                          : "bg-blue-50 border-blue-200"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-sm truncate">
                          {sku.sku.toUpperCase()}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {sku.name.toUpperCase()}
                        </div>
                      </div>
                      <svg
                        className="w-5 h-5 text-green-500 flex-shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 4.5v15m7.5-7.5h-15"
                        />
                      </svg>
                    </button>
                  ))}
                  {availableComponents.length === 0 && (
                    <div className="col-span-full text-center text-gray-500 py-4">
                      {searchTerm
                        ? "NO COMPONENTS MATCH YOUR SEARCH"
                        : "ALL COMPONENTS ALREADY ADDED"}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {selectedType === "RAW" && (
          <div className="card mb-6">
            <div className="card-body">
              <div className="flex items-center gap-3 text-gray-500">
                <svg
                  className="w-6 h-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"
                  />
                </svg>
                <span>
                  RAW MATERIALS DON'T HAVE A BOM - THEY ARE PURCHASED DIRECTLY
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isSubmitting}
          >
            {isSubmitting ? "CREATING..." : "CREATE SKU"}
          </button>
          <Link to="/skus" className="btn btn-secondary">
            CANCEL
          </Link>
        </div>
      </Form>
    </Layout>
  );
}
