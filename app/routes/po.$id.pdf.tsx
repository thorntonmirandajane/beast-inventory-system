import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { requireUser } from "../utils/auth.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { id } = params;

  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          sku: true,
        },
      },
      createdBy: true,
      approvedBy: true,
    },
  });

  if (!po) {
    throw new Response("NOT FOUND", { status: 404 });
  }

  return { user, po };
};

export default function POPdf() {
  const { user, po } = useLoaderData<typeof loader>();
  const printRef = useRef<HTMLDivElement>(null);

  const totalOrdered = po.items.reduce((sum, i) => sum + i.quantityOrdered, 0);
  const totalReceived = po.items.reduce((sum, i) => sum + i.quantityReceived, 0);

  const handlePrint = () => {
    window.print();
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case "SUBMITTED":
        return "PENDING";
      case "PARTIAL":
        return "PARTIALLY RECEIVED";
      case "RECEIVED":
        return "FULLY RECEIVED";
      case "APPROVED":
        return "APPROVED & COMPLETED";
      default:
        return status;
    }
  };

  return (
    <>
      {/* Screen view controls */}
      <div className="print-hide bg-gray-100 min-h-screen">
        <div className="max-w-4xl mx-auto p-6">
          <div className="mb-6 flex items-center justify-between">
            <Link to="/po" className="text-sm text-gray-500 hover:text-gray-700">
              ← BACK TO PURCHASE ORDERS
            </Link>
            <button onClick={handlePrint} className="btn btn-primary">
              PRINT / DOWNLOAD PDF
            </button>
          </div>

          <div className="bg-white rounded-lg shadow-lg p-8" ref={printRef}>
            <PODocument po={po} totalOrdered={totalOrdered} totalReceived={totalReceived} />
          </div>
        </div>
      </div>

      {/* Print view */}
      <div className="print-show">
        <PODocument po={po} totalOrdered={totalOrdered} totalReceived={totalReceived} />
      </div>

      <style>{`
        @media screen {
          .print-show {
            display: none;
          }
        }

        @media print {
          @page {
            size: letter;
            margin: 0.5in;
          }

          body {
            margin: 0;
            padding: 0;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          .print-hide {
            display: none !important;
          }

          .print-show {
            display: block !important;
          }
        }
      `}</style>
    </>
  );
}

function PODocument({
  po,
  totalOrdered,
  totalReceived,
}: {
  po: any;
  totalOrdered: number;
  totalReceived: number;
}) {
  return (
    <div className="po-document">
      {/* Header */}
      <div className="flex justify-between items-start mb-8 pb-4 border-b-2 border-gray-800">
        <div>
          <h1 className="text-3xl font-bold tracking-wider">BEAST</h1>
          <p className="text-sm text-gray-600">INVENTORY MANAGEMENT SYSTEM</p>
        </div>
        <div className="text-right">
          <h2 className="text-2xl font-bold">PURCHASE ORDER</h2>
          <p className="text-xl font-mono mt-1">{po.poNumber}</p>
        </div>
      </div>

      {/* PO Info Grid */}
      <div className="grid grid-cols-2 gap-8 mb-8">
        <div>
          <h3 className="text-sm font-semibold text-gray-500 mb-1">VENDOR</h3>
          <p className="text-lg font-semibold">{po.vendorName.toUpperCase()}</p>
        </div>
        <div className="text-right">
          <h3 className="text-sm font-semibold text-gray-500 mb-1">STATUS</h3>
          <p className="text-lg font-semibold">
            {po.status === "SUBMITTED" && "PENDING"}
            {po.status === "PARTIAL" && "PARTIALLY RECEIVED"}
            {po.status === "RECEIVED" && "FULLY RECEIVED"}
            {po.status === "APPROVED" && "APPROVED & COMPLETED"}
          </p>
        </div>
      </div>

      {/* Dates */}
      <div className="grid grid-cols-3 gap-4 mb-8 p-4 bg-gray-50 rounded">
        <div>
          <h3 className="text-xs font-semibold text-gray-500 mb-1">SUBMITTED DATE</h3>
          <p className="font-medium">
            {new Date(po.submittedAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
        <div>
          <h3 className="text-xs font-semibold text-gray-500 mb-1">ESTIMATED ARRIVAL</h3>
          <p className="font-medium">
            {po.estimatedArrival
              ? new Date(po.estimatedArrival).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })
              : "—"}
          </p>
        </div>
        <div>
          <h3 className="text-xs font-semibold text-gray-500 mb-1">RECEIVED DATE</h3>
          <p className="font-medium">
            {po.receivedAt
              ? new Date(po.receivedAt).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })
              : "—"}
          </p>
        </div>
      </div>

      {/* Created By */}
      <div className="mb-6">
        <h3 className="text-xs font-semibold text-gray-500 mb-1">CREATED BY</h3>
        <p className="font-medium">
          {po.createdBy.firstName.toUpperCase()} {po.createdBy.lastName.toUpperCase()}
        </p>
      </div>

      {/* Items Table */}
      <table className="w-full mb-8">
        <thead>
          <tr className="border-b-2 border-gray-800">
            <th className="text-left py-2 text-sm font-semibold">#</th>
            <th className="text-left py-2 text-sm font-semibold">SKU</th>
            <th className="text-left py-2 text-sm font-semibold">DESCRIPTION</th>
            <th className="text-right py-2 text-sm font-semibold">ORDERED</th>
            <th className="text-right py-2 text-sm font-semibold">RECEIVED</th>
            <th className="text-right py-2 text-sm font-semibold">PENDING</th>
          </tr>
        </thead>
        <tbody>
          {po.items.map((item: any, index: number) => (
            <tr key={item.id} className="border-b border-gray-200">
              <td className="py-3 text-sm">{index + 1}</td>
              <td className="py-3 font-mono text-sm">{item.sku.sku.toUpperCase()}</td>
              <td className="py-3 text-sm">{item.sku.name.toUpperCase()}</td>
              <td className="py-3 text-sm text-right">{item.quantityOrdered}</td>
              <td className="py-3 text-sm text-right">{item.quantityReceived}</td>
              <td className="py-3 text-sm text-right">
                {item.quantityOrdered - item.quantityReceived}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-800 font-semibold">
            <td colSpan={3} className="py-3 text-sm">
              TOTAL
            </td>
            <td className="py-3 text-sm text-right">{totalOrdered}</td>
            <td className="py-3 text-sm text-right">{totalReceived}</td>
            <td className="py-3 text-sm text-right">{totalOrdered - totalReceived}</td>
          </tr>
        </tfoot>
      </table>

      {/* Notes */}
      {po.notes && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-gray-500 mb-2">NOTES</h3>
          <p className="p-3 bg-gray-50 rounded text-sm">{po.notes}</p>
        </div>
      )}

      {/* Approval Section */}
      {po.status === "APPROVED" && po.approvedBy && (
        <div className="mt-8 pt-4 border-t border-gray-300">
          <div className="grid grid-cols-2 gap-8">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-1">APPROVED BY</h3>
              <p className="font-medium">
                {po.approvedBy.firstName.toUpperCase()} {po.approvedBy.lastName.toUpperCase()}
              </p>
            </div>
            <div className="text-right">
              <h3 className="text-xs font-semibold text-gray-500 mb-1">APPROVED DATE</h3>
              <p className="font-medium">
                {po.approvedAt
                  ? new Date(po.approvedAt).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })
                  : "—"}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Signature Lines (for printing) */}
      <div className="mt-12 pt-8 border-t border-gray-300">
        <div className="grid grid-cols-2 gap-16">
          <div>
            <div className="border-b border-gray-400 h-8 mb-2"></div>
            <p className="text-xs text-gray-500">RECEIVING SIGNATURE</p>
          </div>
          <div>
            <div className="border-b border-gray-400 h-8 mb-2"></div>
            <p className="text-xs text-gray-500">DATE</p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-8 pt-4 border-t border-gray-200 text-center text-xs text-gray-400">
        <p>BEAST INVENTORY MANAGEMENT SYSTEM</p>
        <p>GENERATED: {new Date().toLocaleString()}</p>
      </div>
    </div>
  );
}
