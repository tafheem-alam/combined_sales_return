# Copyright (c) 2025, Sowaan Pvt. Ltd
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import cint


class CombinedSalesReturn(Document):
    """
    DocType: Combined Sales Return
    """

    def validate(self):
        """
        Ensure return quantity is negative and does not exceed max_returnable_qty
        """
        for i, row in enumerate(self.combined_sales_return_items, start=1):
            if row.qty > 0:
                frappe.throw(
                    f"Row {i} ({row.item_code}): Quantity must be a negative number."
                )

            if abs(row.qty) > (row.max_returnable_qty or 0):
                frappe.throw(
                    f"Row {i} ({row.item_code}): "
                    f"Return quantity {abs(row.qty)} cannot exceed "
                    f"max returnable quantity {row.max_returnable_qty}."
                )

    def on_submit(self):
        """
        Create credit notes grouped by linked invoice on submit
        """
        try:
            msg = create_credit_notes(self.name)
            if msg:
                frappe.msgprint(msg)
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                "CombinedSalesReturn.on_submit"
            )
            raise


# ----------------------------------------------------------------------
# VAT HELPERS
# ----------------------------------------------------------------------

def get_invoice_vat_rate(invoice_name):
    """
    Fetch VAT rate (%) from Sales Taxes and Charges table
    Handles VAT coming from Taxes & Charges Template
    """
    taxes = frappe.get_all(
        "Sales Taxes and Charges",
        filters={
            "parent": invoice_name,
            "parenttype": "Sales Invoice",
            "docstatus": 1
        },
        fields=["rate", "account_head"]
    )

    for tax in taxes:
        # match VAT account safely
        if tax.account_head and "VAT" in tax.account_head.upper():
            return float(tax.rate or 0)

    return 0.0


# ----------------------------------------------------------------------
# FETCH SALES INVOICE ITEMS (WITH VAT SUPPORT)
# ----------------------------------------------------------------------

@frappe.whitelist()
def get_sales_invoice_items(customer=None, sales_invoice=None, select_all=0, item_code=None):
    """
    Fetch Sales Invoice Items and attach VAT info from Taxes table
    """
    if not customer:
        frappe.throw("Customer is required.")

    select_all = cint(select_all)

    sql = """
    SELECT
        sii.parent AS sales_invoice,
        sii.name AS invoice_item_row,
        sii.item_code,
        sii.item_name,
        sii.description,
        sii.qty,
        sii.rate,
        sii.amount,
        sii.uom,
        sii.territory AS territory
    FROM `tabSales Invoice Item` sii
    INNER JOIN `tabSales Invoice` si ON sii.parent = si.name
    WHERE
        si.docstatus = 1
        AND si.is_return = 0


    """

    params = {"customer": customer}

    # Case 1: Item filter is applied → search ALL invoices of customer
    if item_code:
        sql += " AND si.customer = %(customer)s"

    # Case 2: Explicitly fetch all invoices
    elif select_all:
        sql += " AND si.customer = %(customer)s"

    # Case 3: Specific invoice selected
    else:
        if not sales_invoice:
            return []
        sql += " AND si.name = %(sales_invoice)s"
        params["sales_invoice"] = sales_invoice

    # ----------------------------------------
    # Item filter (ALWAYS by item_code)
    # ----------------------------------------
    if item_code:
        sql += " AND sii.item_code = %(item_code)s"
        params["item_code"] = item_code
        sql += " ORDER BY si.posting_date DESC"

    rows = frappe.db.sql(sql, params, as_dict=True)

    frappe.msgprint(f"Rows {rows}")

    # ----------------------------------------------------------
    # Attach VAT rate & VAT amount PER ITEM (derived correctly)
    # ----------------------------------------------------------
    invoice_vat_cache = {}

    for r in rows:
        inv = r.sales_invoice

        if inv not in invoice_vat_cache:
            vat_rate = get_invoice_vat_rate(inv)
            invoice_vat_cache[inv] = vat_rate
        else:
            vat_rate = invoice_vat_cache[inv]

        vat_ratio = vat_rate / 100 if vat_rate else 0

        line_amount = (r.qty or 0) * (r.rate or 0)
        vat_amount = line_amount * vat_ratio

        r["uom"] = r.uom 
        r["vat_rate_ratio"] = vat_ratio
        r["vat_amount"] = vat_amount
        r["original_qty"] = r.qty
        r["max_returnable_qty"] = abs(r.qty or 0)

    return rows


# ----------------------------------------------------------------------
# CREATE CREDIT NOTES
# ----------------------------------------------------------------------

@frappe.whitelist()
def create_credit_notes(docname, submit_credit_notes=False):
    """
    Create Credit Notes grouped by Linked Invoice
    INCLUDING company, taxes, and proper totals
    """
    doc = frappe.get_doc("Combined Sales Return", docname)

    grouped = {}
    for row in doc.combined_sales_return_items:
        if row.linked_invoice:
            grouped.setdefault(row.linked_invoice, []).append(row)

    messages = []

    for invoice, items in grouped.items():
        original_si = frappe.get_doc("Sales Invoice", invoice)

        cn = frappe.get_doc({
            "doctype": "Sales Invoice",
            "company": original_si.company,          # ✅ REQUIRED
            "customer": original_si.customer,
            "is_return": 1,
            "return_against": original_si.name,
            "posting_date": frappe.utils.nowdate(),
            "taxes_and_charges": original_si.taxes_and_charges,
            "credit_note.update_outstanding_for_self" : 0,
            ""
            #"combined_sales_return": doc.name,
            "items": [],
            "taxes": []
        })

        # --------------------------------------------------
        # 1️⃣ ITEMS (NEGATIVE QTY)
        # --------------------------------------------------
        for item in items:
            qty = item.qty if item.qty < 0 else -abs(item.qty)

            cn.append("items", {
                "item_code": item.item_code,
                "qty": qty,
                "rate": item.rate,
                "uom": item.uom,
                "territory" : item.territory
            })

        # --------------------------------------------------
        # 2️⃣ TAXES (COPIED FROM ORIGINAL SI)
        # --------------------------------------------------
        for tax in original_si.taxes:
            cn.append("taxes", {
                "charge_type": tax.charge_type,
                "account_head": tax.account_head,
                "description": tax.description,
                "rate": tax.rate,
                "included_in_print_rate": tax.included_in_print_rate,
                "cost_center": tax.cost_center
            })

        # --------------------------------------------------
        # 3️⃣ CALCULATE TOTALS (MANDATORY)
        # --------------------------------------------------
        cn.set_missing_values()
        cn.calculate_taxes_and_totals()

        cn.insert(ignore_permissions=True)

        if submit_credit_notes:
            cn.submit()

        messages.append(f"Credit Note created for {invoice}: {cn.name}")

    return "\n".join(messages)


