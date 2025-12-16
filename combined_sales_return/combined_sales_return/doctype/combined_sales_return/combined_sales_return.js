// combined_sales_return.js - ensure item_code & item_name display reliably

frappe.ui.form.on("Combined Sales Return", {
    refresh(frm) {
        let btn = frm.add_custom_button("Get Sales Invoice Items", () => {
            if (!frm.doc.customer) {
                frappe.msgprint("Please select a Customer first.");
                return;
            }
            open_sales_invoice_selector(frm);
        });
        btn.toggleClass('disabled', !frm.doc.customer);
    },
    customer(frm) { frm.refresh(); },
    onload(frm) {
        if (frm.doc.combined_sales_return_items) {
            frm.doc.combined_sales_return_items = frm.doc.combined_sales_return_items.filter(r => r.item || r.item_code);
        }
        frm.refresh_field("combined_sales_return_items");
    }
});

// helpers
function flt_js(v) {
    if (typeof v === "number") return parseFloat(v);
    v = (v || 0).toString().trim();
    return v === "" ? 0 : parseFloat(v) || 0;
}
function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }
function debounce(fn, wait = 200) {
    let t;
    return function(...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
}

// write amounts helper (unchanged)
function writeAmountsToChild(doctype, name, lineAmount, totalAmount, frm) {
    const candidates = ["amount", "line_amount", "amount_local", "total_amount"];
    let wrote = false;
    for (let fn of candidates) {
        if (frappe.meta.get_docfield(doctype, fn, frm.doc.name)) {
            const value = (fn === "total_amount") ? totalAmount : lineAmount;
            frappe.model.set_value(doctype, name, fn, value);
            wrote = true;
        }
    }
    if (!wrote) {
        // fallback: ensure JS object has values (grid sometimes renders these)
        frappe.model.set_value(doctype, name, "amount", lineAmount);
        frappe.model.set_value(doctype, name, "total_amount", totalAmount);
    }
}

// Qty handler (recalculate vat/amounts)
frappe.ui.form.on("Sales Return Item", {
    qty(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (!row) return;

        let newQty = flt(row.qty);
        const rate = flt(row.rate);
        const maxReturnable = flt(row.max_returnable_qty || 0);

        /* ------------------------------
           1. Enforce negative quantity
        --------------------------------*/
        if (newQty > 0) {
            frappe.msgprint(
                `For item ${row.item_code}, quantity must be a negative number.`
            );
            newQty = -Math.abs(newQty);
        }

        /* ------------------------------
           2. Enforce max returnable qty
        --------------------------------*/
        if (maxReturnable >= 0 && Math.abs(newQty) > maxReturnable) {
            frappe.msgprint(
                `Return quantity for item ${row.item_code} cannot exceed ${maxReturnable}. Adjusting.`
            );
            newQty = -Math.abs(maxReturnable);
        }

        /* ------------------------------
           3. Update qty ONLY if changed
        --------------------------------*/
        if (row.qty !== newQty) {
            frappe.model.set_value(cdt, cdn, "qty", newQty);
            return; // let handler re-run once with corrected qty
        }

        /* ------------------------------
           4. VAT calculation
        --------------------------------*/
        let vatForReturn = 0;

        const originalVat = flt(row.original_vat || row._original_vat || 0);
        const originalQty = flt(row.original_qty || row._original_qty || 0);

        if (originalVat && originalQty) {
            vatForReturn = -Math.abs(
                originalVat * (Math.abs(newQty) / originalQty)
            );
        } else {
            const vatRatio = flt(row.vat_rate_ratio || row._vat_rate_ratio || 0);
            vatForReturn = newQty * rate * vatRatio;
        }

        vatForReturn = round2(vatForReturn);

        /* ------------------------------
           5. Amount calculation (KEY PART)
        --------------------------------*/
        const lineAmount = round2(newQty * rate);
        const totalAmount = round2(lineAmount + vatForReturn);

        frappe.model.set_value(cdt, cdn, "amount", lineAmount);

        if (frappe.meta.get_docfield("Sales Return Item", "vat_amount", frm.doc.name)) {
            frappe.model.set_value(cdt, cdn, "vat_amount", vatForReturn);
        } else {
            row._vat_amount = vatForReturn;
        }

        /* ------------------------------
           6. Write totals & refresh
        --------------------------------*/
        writeAmountsToChild(
            "Sales Return Item",
            row.name,
            lineAmount,
            -Math.abs(totalAmount),
            frm
        );

        frm.trigger("calculate_totals");
        frm.refresh_field("combined_sales_return_items");
    }
});


// Dialog to select invoice items
function open_sales_invoice_selector(frm) {
    let dialog = new frappe.ui.Dialog({
        title: "Select Sales Invoice Items",
        size: "large",
        fields: [
            { label: "Customer", fieldname: "customer", fieldtype: "Link", options: "Customer", reqd: 1, default: frm.doc.customer, read_only: 1 },
            { label: "Sales Invoice", fieldname: "sales_invoice", fieldtype: "Link", options: "Sales Invoice", depends_on: "eval:!doc.select_all" },
            { label: "Fetch All Items from Customer Invoices", fieldname: "select_all", fieldtype: "Check" },
            { label: "Invoice Items", fieldname: "invoice_items_html", fieldtype: "HTML" }
        ],
        primary_action: function() {
            const $wrapper = dialog.fields_dict.invoice_items_html.$wrapper;
            const $checked = $wrapper.find('input.invoice-row-choose:checked');
            if (!$checked.length) {
                frappe.msgprint("No items selected.");
                return;
            }

            const selected_items = [];
            $checked.each(function() {
                const $chk = $(this);
                selected_items.push({
                    sales_invoice: $chk.data('sales-invoice'),
                    invoice_item_row: $chk.data('invoice-item-row'),
                    item_code: $chk.data('item-code'),
                    item_name: $chk.data('item-name') || "",
                    description: $chk.data('description'),
                    uom: $chk.data('uom'),   // ✅ ADD THIS
                    qty: parseFloat($chk.data('qty')) || 0,
                    rate: parseFloat($chk.data('rate')) || 0,
                    amount: parseFloat($chk.data('amount')) || 0,
                    max_returnable_qty: parseFloat($chk.data('max-returnable')) || 0,
                    vat_rate_ratio: parseFloat($chk.data('vat-rate')) || 0,
                    vat_amount: parseFloat($chk.data('vat-amount')) || 0
                });
            });

            add_items_to_child_table(frm, selected_items);
            dialog.hide();
        }
    });

    // filter
    dialog.fields_dict.sales_invoice.get_query = function() { return { filters: { customer: frm.doc.customer } }; };

    // df.onchange will run when value actually changes
    dialog.fields_dict.sales_invoice.df.onchange = function() {
        dialog.fields_dict.sales_invoice.refresh();
        load_invoice_items_html(dialog, frm);
    };

    // show then bind input (some Frappe builds create $input only after show)
    dialog.show();

    const debounced_load = debounce(() => {
        if (!dialog || !dialog.fields_dict) return;
        load_invoice_items_html(dialog, frm);
    }, 220);

    // namespaced to avoid duplicate bindings
    try { dialog.fields_dict.sales_invoice.$input.off('change.csr'); } catch (e) {}
    dialog.fields_dict.sales_invoice.$input.on('change.csr', debounced_load);

    try { dialog.fields_dict.select_all.$input.off('change.csr'); } catch (e) {}
    dialog.fields_dict.select_all.$input.on('change.csr', debounced_load);

    // initial load
    load_invoice_items_html(dialog, frm);
}

// Safely escape text for HTML attribute (tooltips)
function escape_attr(val) {
    return frappe.utils.escape_html(val || "").replace(/"/g, "&quot;");
}
// Load and render invoice items
let _is_loading_invoice_items = false;
function load_invoice_items_html(dialog, frm) {
    if (!dialog || !dialog.fields_dict || _is_loading_invoice_items) return;
    _is_loading_invoice_items = true;

    const values = dialog.get_values();
    dialog.fields_dict.invoice_items_html.set_value(`<div style="padding:12px; min-height:120px">Loading...</div>`);

    frappe.call({
        method: "combined_sales_return.combined_sales_return.doctype.combined_sales_return.combined_sales_return.get_sales_invoice_items",
        args: { customer: values.customer, sales_invoice: values.sales_invoice, select_all: values.select_all ? 1 : 0 },
        callback(r) {
            const rows = (r.message || []);
            if (!rows.length) {
                dialog.fields_dict.invoice_items_html.set_value(`<div style="padding:12px; min-height:120px">No items found.</div>`);
                _is_loading_invoice_items = false;
                return;
            }

            let html = `
                <div style="max-height:60vh; overflow:auto; padding:8px; min-height:200px;">
                <table class="table table-bordered" style="width:100%; border-collapse:collapse; table-layout: fixed;">
                    <colgroup>
                        <col style="width:40px">
                        <col style="width:120px">
                        <col style="width:140px">
                        <col>
                        <col style="width:70px">
                        <col style="width:80px">
                        <col style="width:80px">
                        <col style="width:100px">
                    </colgroup>
                    <thead>
                        <tr>
                            <th style="text-align:center"><input type="checkbox" id="invoice_select_all"></th>
                            <th>Invoice</th>
                            <th>Item Code</th>
                            <th>Description</th>
                            <th>UOM</th>
                            <th style="text-align:right">Qty</th>
                            <th style="text-align:right">Rate</th>
                            <th style="text-align:right">Amount</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            rows.forEach((row, idx) => {
                const safeDesc = (row.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const safeInvoice = frappe.utils.escape_html(row.sales_invoice || '');
                const safeItemCode = frappe.utils.escape_html(row.item_code || '');
                const safeItemName = frappe.utils.escape_html(row.item_name || "");
                const dataMax = row.max_returnable_qty || 0;
                const dataVatRate = row.vat_rate_ratio || 0;
                const dataVat = row.vat_amount || 0;
                const dataQty = row.original_qty || row.qty || 0;
                const safeUOM = frappe.utils.escape_html(row.uom || "");

                // amount shown: server amount if present, else compute
                const showLineAmount = round2(flt_js(row.amount || (dataQty * (row.rate || 0))));
                const showTotal = round2(showLineAmount + (row.vat_amount ? flt_js(row.vat_amount) : 0));

                html += `
                    <tr data-idx="${idx}">
                        <td style="text-align:center">
                            <input class="invoice-row-choose" type="checkbox"
                                data-sales-invoice="${safeInvoice}"
                                data-invoice-item-row="${frappe.utils.escape_html(row.invoice_item_row||'')}"
                                data-item-code="${safeItemCode}"
                                data-item-name="${safeItemName}"
                                data-description="${frappe.utils.escape_html(row.description||'')}"
                                data-uom="${safeUOM}"
                                data-qty="${dataQty}"
                                data-rate="${row.rate || 0}"
                                data-amount="${showLineAmount}"
                                data-max-returnable="${dataMax}"
                                data-vat-rate="${dataVatRate}"
                                data-vat-amount="${dataVat}"
                                id="invoice_row_chk_${idx}">
                        </td>
                        <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${safeInvoice}</td>
                        <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${safeItemCode}</td>
                        <td style="word-break:break-word">${safeItemName ? safeItemName + " — " + safeDesc : safeDesc}</td>
                        <td style="text-align:center" title="${escape_attr(row.uom)}">${safeUOM}</td>
                        <td style="text-align:right">${dataQty}</td>
                        <td style="text-align:right">${(row.rate || 0).toFixed(2)}</td>
                        <td style="text-align:right">${showLineAmount.toFixed(2)}</td>
                    </tr>`;
            });

            html += `</tbody></table></div>`;

            dialog.fields_dict.invoice_items_html.set_value(html);

            // delegated handlers (unbind then bind)
            const $wrapper = dialog.fields_dict.invoice_items_html.$wrapper;
            $wrapper.off('change', '#invoice_select_all');
            $wrapper.on('change', '#invoice_select_all', function() {
                const checked = $(this).is(':checked');
                $wrapper.find('input.invoice-row-choose').prop('checked', checked);
            });

            $wrapper.off('click', 'tbody tr');
            $wrapper.on('click', 'tbody tr', function(e){
                if ($(e.target).is('input')) return;
                const $chk = $(this).find('input.invoice-row-choose');
                $chk.prop('checked', !$chk.prop('checked'));
            });

            $wrapper.off('click', 'input.invoice-row-choose');
            $wrapper.on('click', 'input.invoice-row-choose', function(e){
                e.stopPropagation();
            });

            _is_loading_invoice_items = false;
        },
        error(err) {
            dialog.fields_dict.invoice_items_html.set_value(`<div style="padding:12px; color:red">Error loading items.</div>`);
            console.error(err);
            _is_loading_invoice_items = false;
        }
    });
}

// Add items to child table and ensure item fields are written
function add_items_to_child_table(frm, items) {
    let added = 0;

    const has_item_field = !!frappe.meta.get_docfield("Combined Sales Return Items", "item", frm.doc.name);
    const has_item_code_field = !!frappe.meta.get_docfield("Combined Sales Return Items", "item_code", frm.doc.name);
    const has_item_name_field = !!frappe.meta.get_docfield("Combined Sales Return Items", "item_name", frm.doc.name);
    const has_original_vat = !!frappe.meta.get_docfield("Combined Sales Return Items", "original_vat", frm.doc.name);
    const has_vat_rate = !!frappe.meta.get_docfield("Combined Sales Return Items", "vat_rate_ratio", frm.doc.name);

    items.forEach(item => {
        // prevent duplicates by sales_invoice_item primary key
        let exists = (frm.doc.combined_sales_return_items || []).some(d => d.sales_invoice_item === item.invoice_item_row);
        if (!exists) {
            let row = frm.add_child("combined_sales_return_items");

            // decide canonical item code (must be exact Item code if Link)
            const item_code_val = item.item_code || item.item || item.item_name || "";            

            // set both item and item_code if present
           
            frappe.model.set_value(row.doctype, row.name, "item", item_code_val);
            
            frappe.model.set_value(row.doctype, row.name, "item_code", item_code_val);
            

            //console.log(has_item_code_field)

            // set a placeholder for item_name then fetch the actual if missing
            if (has_item_name_field) {
                frappe.model.set_value(row.doctype, row.name, "item_name", item.item_name || __("Loading..."));
            }
            
            // set basic fields
            frappe.model.set_value(row.doctype, row.name, "linked_invoice", item.sales_invoice);
            frappe.model.set_value(row.doctype, row.name, "sales_invoice_item", item.invoice_item_row);
            frappe.model.set_value(row.doctype, row.name, "description", item.description || "");

            frappe.model.set_value(row.doctype, row.name, "uom", item.uom);
            // quantities and rates
            const originalQty = flt_js(item.qty || item.original_qty || 0);
            frappe.model.set_value(row.doctype, row.name, "original_qty", originalQty);

            const maxReturnable = Math.max(flt_js(item.max_returnable_qty || originalQty || 0), 0);
            frappe.model.set_value(row.doctype, row.name, "max_returnable_qty", maxReturnable);

            let desired = originalQty;
            if (desired > maxReturnable) desired = maxReturnable;
            frappe.model.set_value(row.doctype, row.name, "qty", -Math.abs(desired || 0));

            frappe.model.set_value(row.doctype, row.name, "rate", flt_js(item.rate || 0));

            // VAT fields
            
            frappe.model.set_value(row.doctype, row.name, "vat_rate_ratio", flt_js(item.vat_rate_ratio || 0));
           
            const invoice_vat = flt_js(item.vat_amount || 0);           
            frappe.model.set_value(row.doctype, row.name, "original_vat", invoice_vat);
            
            // compute initial vat and amounts
            const curQty = -Math.abs(desired || 0);
            let vatForReturn = 0;
            if (invoice_vat && originalQty) {
                vatForReturn = -Math.abs(invoice_vat * (Math.abs(curQty) / originalQty));
            } else {
                const vatRatio = flt_js(item.vat_rate_ratio || 0);
                vatForReturn = flt_js(curQty * flt_js(item.rate || 0) * vatRatio);
            }
            vatForReturn = round2(vatForReturn);
            const lineAmount = round2(curQty * flt_js(item.rate || 0));
            const totalAmount = round2(lineAmount + vatForReturn);

            // set vat_amount
            if (frappe.meta.get_docfield("Combined Sales Return Items", "vat_amount", frm.doc.name)) {
                frappe.model.set_value(row.doctype, row.name, "vat_amount", vatForReturn);
            } else {
                row._vat_amount = vatForReturn;
            }

            // write amounts
            writeAmountsToChild(row.doctype, row.name, lineAmount, -Math.abs(totalAmount), frm);

            // fetch item_name from Item doctype if needed (non-blocking)
            if (has_item_name_field && item_code_val) {
                frappe.db.get_value("Item", item_code_val, "item_name").then(res => {
                    const nm = (res && res.message && res.message.item_name) ? res.message.item_name : (item.item_name || "");
                    frappe.model.set_value(row.doctype, row.name, "item_name", nm);
                    frm.refresh_field("combined_sales_return_items");
                }).catch(() => {
                    // ignore if item not found
                    frappe.model.set_value(row.doctype, row.name, "item_name", item.item_name || "");
                });
            }

            added++;
        }
    });

    // final refresh so grid shows all values
    frm.refresh_field("combined_sales_return_items");
    if (added) frappe.msgprint(`${added} item(s) added.`);
}
