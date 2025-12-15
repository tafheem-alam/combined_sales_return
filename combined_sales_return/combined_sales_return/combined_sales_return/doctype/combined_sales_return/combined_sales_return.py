# Copyright (c) 2025, Sowaan Pvt. Ltd and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document

class CombinedSalesReturn(Document):
    """
    DocType: Combined Sales Return
    """
    def validate(self):
        """Ensure return quantity is negative and does not exceed max_returnable_qty"""
        for i, row in enumerate(self.combined_sales_return_items, start=1):
            if row.qty > 0:
                frappe.throw(
                    f"Row {i} ({row.item_code}): Quantity must be a negative number."
                )
            if abs(row.qty) > (row.max_returnable_qty or 0):
                frappe.throw(
                    f"Row {i} ({row.item_code}): Return quantity {row.qty} cannot exceed max returnable quantity {row.max_returnable_qty}."
                )

    def on_submit(self):
        """
        Called automatically when the Combined Sales Return document is submitted.
        We create credit notes grouped by linked invoice.
        """
        # call the existing function which creates credit notes
        # wrap in try/except so submit doesn't fail silently or break the user flow
        try:
            msg = create_credit_notes(self.name)
            # Optionally show a server message in the UI (useful for debugging)
            if msg:
                frappe.msgprint(msg)
        except Exception:
            # re-raise so ERPNext surface the error during submit
            frappe.log_error(frappe.get_traceback(), "CombinedSalesReturn.on_submit")
            raise

@frappe.whitelist()
def get_sales_invoice_items(customer=None, sales_invoice=None, select_all=0):
    """
    Fetch Sales Invoice Items for a customer or a specific invoice.
    """
    if not customer:
        frappe.throw("Customer is required.")

    select_all = frappe.utils.cint(select_all)

    sql = """
        SELECT
            sii.parent AS sales_invoice,
            sii.name AS invoice_item_row,
            sii.item_code,
            sii.description,
            sii.qty,
            sii.rate
        FROM `tabSales Invoice Item` sii
        LEFT JOIN `tabSales Invoice` si ON sii.parent = si.name
        WHERE si.docstatus = 1 AND si.is_return = 0
    """

    params = {"customer": customer}

    if select_all == 1:
        sql += " AND si.customer = %(customer)s"
    else:
        if not sales_invoice:
            return []
        sql += " AND si.name = %(sales_invoice)s"
        params["sales_invoice"] = sales_invoice

    sql += " ORDER BY si.posting_date DESC"

    return frappe.db.sql(sql, params, as_dict=True)


@frappe.whitelist()
def create_credit_notes(docname, submit_credit_notes=False):
    """
    Create Credit Notes grouped by Linked Invoice.
    Returns a message summarizing created credit notes.

    Args:
        docname (str): Combined Sales Return name
        submit_credit_notes (bool): if True, the created credit notes will be submitted
    """
    doc = frappe.get_doc("Combined Sales Return", docname)

    grouped = {}
    for row in doc.combined_sales_return_items:
        invoice = row.linked_invoice
        if not invoice:
            continue
        grouped.setdefault(invoice, []).append(row)

    messages = []
    for invoice, items in grouped.items():
        cn = frappe.get_doc({
            "doctype": "Sales Invoice",   # ERPNext using Sales Invoice with is_return = 1
            "customer": doc.customer,
            "is_return": 1,
            "combined_sales_return": doc.name,
            "items": []
        })
        for item in items:
            # ensure qty for return is negative (your UI already enforces negative qty)
            qty = item.qty
            # if qty is positive for some reason, negate it
            if qty > 0:
                qty = -abs(qty)

            cn.append("items", {
                "item_code": item.item_code,
                "qty": qty,
                "rate": item.rate,
                "amount": item.amount
            })

        cn.insert(ignore_permissions=True)

        if submit_credit_notes:
            # will raise if submission rules fail; catch above in on_submit wrapper
            cn.submit()

        messages.append(f"Credit Note created for {invoice}: {cn.name}")

    return "\n".join(messages)
