import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, useSearchParams } from "react-router";
import { useEffect, useRef, useState } from "react";
import { requireUser } from "../utils/auth.server";
import prisma from "../db.server";
import JsBarcode from "jsbarcode";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const skuIds = url.searchParams.get("ids")?.split(",") || [];

  // Get selected SKUs or all active SKUs if none selected
  const skus = await prisma.sku.findMany({
    where: skuIds.length > 0
      ? { id: { in: skuIds } }
      : { isActive: true },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  return { user, skus };
};

function BarcodeLabel({ sku, name, id }: { sku: string; name: string; id: string }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (svgRef.current) {
      JsBarcode(svgRef.current, sku.toUpperCase(), {
        format: "CODE39",
        width: 2,
        height: 80,
        displayValue: true,
        fontSize: 14,
        font: "monospace",
        textMargin: 8,
        margin: 10,
        background: "#ffffff",
      });
    }
  }, [sku]);

  return (
    <div className="barcode-label">
      <div className="barcode-header">
        <span className="barcode-title">BEAST INVENTORY</span>
      </div>
      <div className="barcode-content">
        <svg ref={svgRef}></svg>
      </div>
      <div className="barcode-footer">
        <span className="barcode-name">{name.toUpperCase()}</span>
      </div>
    </div>
  );
}

export default function PrintBarcodes() {
  const { user, skus } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(new Set());
  const [showPreview, setShowPreview] = useState(false);

  const toggleSku = (id: string) => {
    const newSelected = new Set(selectedSkus);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedSkus(newSelected);
  };

  const selectAll = () => {
    setSelectedSkus(new Set(skus.map((s) => s.id)));
  };

  const selectNone = () => {
    setSelectedSkus(new Set());
  };

  const handlePrint = () => {
    window.print();
  };

  const skusToShow = showPreview && selectedSkus.size > 0
    ? skus.filter((s) => selectedSkus.has(s.id))
    : [];

  return (
    <>
      {/* Screen view - selection interface */}
      <div className="print-hide">
        <div className="min-h-screen bg-gray-100 p-6">
          <div className="max-w-4xl mx-auto">
            <div className="mb-6">
              <Link to="/skus" className="text-sm text-gray-500 hover:text-gray-700">
                ← BACK TO SKU CATALOG
              </Link>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
              <h1 className="text-2xl font-bold text-gray-900 mb-2">PRINT SKU BARCODES</h1>
              <p className="text-gray-500 mb-6">SELECT SKUS TO PRINT AS CODE39 BARCODES ON 4X6 LABELS</p>

              {/* Selection controls */}
              <div className="flex items-center gap-4 mb-4 pb-4 border-b border-gray-200">
                <button
                  onClick={selectAll}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  SELECT ALL
                </button>
                <button
                  onClick={selectNone}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  SELECT NONE
                </button>
                <span className="text-sm text-gray-500">
                  {selectedSkus.size} OF {skus.length} SELECTED
                </span>
              </div>

              {/* SKU list */}
              <div className="space-y-2 max-h-96 overflow-y-auto mb-6">
                {skus.map((sku) => (
                  <label
                    key={sku.id}
                    className={`flex items-center gap-3 p-3 rounded border cursor-pointer transition-colors ${
                      selectedSkus.has(sku.id)
                        ? "bg-blue-50 border-blue-300"
                        : "bg-gray-50 border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSkus.has(sku.id)}
                      onChange={() => toggleSku(sku.id)}
                      className="w-5 h-5 text-blue-600"
                    />
                    <div className="flex-1">
                      <span className="font-mono font-semibold text-gray-900">
                        {sku.sku.toUpperCase()}
                      </span>
                      <span className="mx-2 text-gray-400">—</span>
                      <span className="text-gray-600">{sku.name.toUpperCase()}</span>
                    </div>
                    <span
                      className={`px-2 py-1 text-xs rounded ${
                        sku.type === "RAW"
                          ? "bg-gray-200 text-gray-700"
                          : sku.type === "ASSEMBLY"
                          ? "bg-blue-200 text-blue-700"
                          : "bg-green-200 text-green-700"
                      }`}
                    >
                      {sku.type}
                    </span>
                  </label>
                ))}
              </div>

              {/* Action buttons */}
              <div className="flex gap-3">
                <button
                  onClick={() => setShowPreview(true)}
                  disabled={selectedSkus.size === 0}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  PREVIEW ({selectedSkus.size})
                </button>
                <button
                  onClick={handlePrint}
                  disabled={selectedSkus.size === 0 || !showPreview}
                  className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  PRINT LABELS
                </button>
              </div>
            </div>

            {/* Preview section */}
            {showPreview && selectedSkus.size > 0 && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">PRINT PREVIEW</h2>
                  <button
                    onClick={() => setShowPreview(false)}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    CLOSE PREVIEW
                  </button>
                </div>
                <p className="text-sm text-gray-500 mb-4">
                  EACH LABEL IS SIZED FOR 4" X 6" THERMAL LABELS
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {skusToShow.map((sku) => (
                    <div key={sku.id} className="border border-gray-300 rounded p-2">
                      <BarcodeLabel sku={sku.sku} name={sku.name} id={sku.id} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Print view - actual labels */}
      <div className="print-show">
        {skusToShow.map((sku, index) => (
          <div key={sku.id} className="print-page">
            <BarcodeLabel sku={sku.sku} name={sku.name} id={sku.id} />
          </div>
        ))}
      </div>

      <style>{`
        /* Screen styles */
        .print-show {
          display: none;
        }

        .barcode-label {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 16px;
          box-sizing: border-box;
        }

        .barcode-header {
          text-align: center;
          margin-bottom: 8px;
        }

        .barcode-title {
          font-size: 18px;
          font-weight: bold;
          letter-spacing: 2px;
          color: #333;
        }

        .barcode-content {
          display: flex;
          justify-content: center;
          align-items: center;
        }

        .barcode-content svg {
          max-width: 100%;
          height: auto;
        }

        .barcode-footer {
          text-align: center;
          margin-top: 8px;
        }

        .barcode-name {
          font-size: 14px;
          font-weight: 500;
          color: #333;
          word-break: break-word;
        }

        /* Print styles */
        @media print {
          @page {
            size: 4in 6in;
            margin: 0;
          }

          body {
            margin: 0;
            padding: 0;
          }

          .print-hide {
            display: none !important;
          }

          .print-show {
            display: block !important;
          }

          .print-page {
            width: 4in;
            height: 6in;
            page-break-after: always;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
          }

          .print-page:last-child {
            page-break-after: auto;
          }

          .barcode-label {
            width: 3.5in;
            height: 5.5in;
          }

          .barcode-title {
            font-size: 24px;
          }

          .barcode-content svg {
            width: 3in;
            height: auto;
          }

          .barcode-name {
            font-size: 16px;
            max-width: 3in;
          }
        }
      `}</style>
    </>
  );
}
