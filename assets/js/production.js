/* production.js - Handles Production Batches and Inventory Synchronization */

let allProductions = [];
let cachedProducts = [];
let cachedInventory = [];
let editingProductionId = null;
let currentLines = [];

async function loadData() {
  try {
    updatePageDebug('Loading...', '#10B981');
    
    // Fetch Products (Finished Goods) for top-level record
    const { data: prodData } = await window.dbClient.from('products').select('id, name');
    cachedProducts = prodData || [];
    
    // Fetch Inventory (Raw Materials & Finished Goods) for line items
    const { data: invData } = await window.dbClient.from('inventory_items').select('id, name, unit');
    cachedInventory = invData || [];
    
    // Fetch Production Batches (Checking formulations table which stores manufacturing production batches)
    let prodBatches = [];
    const { data: fData, error: fError } = await window.dbClient.from('formulations')
      .select('*, formulation_ingredients(*)')
      .order('date', { ascending: false });
      
    if (!fError && fData) {
      prodBatches = fData.map(f => ({
        id: f.id,
        batch_no: f.batch_no,
        product_id: f.product_id,
        product_name: f.product_name,
        formula_name: f.product_name,
        date: f.date,
        quantity_produced: f.batch_size || f.total_quantity || 0,
        notes: f.notes,
        production_ingredients: (f.formulation_ingredients || []).map(ing => ({
          id: ing.id,
          inventory_id: ing.product_id,
          quantity_used: ing.quantity || 0
        }))
      }));
    } else {
      // Fallback try production_batches if table exists
      const { data: pbData, error: pbErr } = await window.dbClient.from('production_batches')
        .select('*, production_ingredients(*)')
        .order('date', { ascending: false });
      if (!pbErr && pbData) {
        prodBatches = pbData;
      }
    }
    
    allProductions = (prodBatches || []).sort((a, b) => (a.batch_no || '').localeCompare(b.batch_no || '', undefined, { numeric: true, sensitivity: 'base' }));
    
    populateProductSelect();
    renderTable(allProductions);
    updatePageDebug('Ready (' + allProductions.length + ')', '#10B981');
  } catch (err) {
    console.error('loadData failed:', err);
    updatePageDebug('Ready (0)', '#10B981');
    renderTable([]);
  }
}

function updatePageDebug(text, color) {
  const el = document.getElementById('debug-page-status');
  if (el) { el.textContent = 'Page: ' + text; if (color) el.style.color = color; }
}

function populateProductSelect() {
  const select = document.getElementById('product-select');
  if (!select) return;
  if (select._ussInstance) select._ussInstance.destroy();
  select.innerHTML = '<option value="">Select Product...</option>' + 
    cachedProducts.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  if (window.UniversalSearchSelect) new UniversalSearchSelect(select);
}

function renderTable(data) {
  const tbody = document.querySelector('#production-table tbody');
  if (!tbody) return;
  
  if (!data.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="empty-state"><h3>No production batches found</h3><p>Create your first batch.</p></div></td></tr>`;
    return;
  }
  
  tbody.innerHTML = data.map(b => {
    return `<tr>
      <td><input type="checkbox"></td>
      <td class="cell-bold">${b.batch_no || '-'}</td>
      <td>${b.product_name || '-'}</td>
      <td>${b.formula_name || '-'}</td>
      <td>${UTILS.fmtDate(b.date)}</td>
      <td>${b.quantity_produced || 0}</td>
      <td>
        <div class="action-btns">
          <button class="icon-btn" onclick="editProduction(${b.id})" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
          <button class="icon-btn delete-btn" onclick="deleteProduction(${b.id})" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>
      </td>
    </tr>`;
  }).join('');
  
  UTILS.applyMobileTableLabels('production-table');
}

async function getNextProductionBatchNo() {
  try {
    const { data: formBatches } = await window.dbClient
      .from('formulations')
      .select('batch_no');
      
    let maxNum = 0;
    const all = [...(allProductions || []), ...(formBatches || [])];
    for (const b of all) {
      if (b.batch_no && typeof b.batch_no === 'string') {
        const match = b.batch_no.match(/^(?:BATCH|B)-(\d+)$/i);
        if (match) {
          const n = parseInt(match[1], 10);
          if (!isNaN(n) && n > maxNum && n < 100000) {
            maxNum = n;
          }
        }
      }
    }
    return `BATCH-${String(maxNum + 1).padStart(2, '0')}`;
  } catch (err) {
    console.error('Error getting next production batch no:', err);
    return 'BATCH-01';
  }
}

async function openProductionModal() {
  editingProductionId = null;
  document.getElementById('production-form').reset();
  document.querySelector('[name="date"]').value = UTILS.todayStr();
  
  const select = document.getElementById('product-select');
  if (select) {
    select.value = "";
    if (select._ussInstance) {
      select._ussInstance.updateOptions();
    } else if (window.UniversalSearchSelect) {
      new UniversalSearchSelect(select);
    }
  }
  
  const nextBatch = await getNextProductionBatchNo();
  const batchField = document.querySelector('#production-form [name="batch_no"]');
  if (batchField) batchField.value = nextBatch;

  currentLines = [];
  addIngredientRow();
  APP.openModal('production-modal');
}

async function editProduction(id) {
  const b = allProductions.find(x => x.id === id);
  if (!b) return;
  
  editingProductionId = id;
  UTILS.populateForm('production-form', b);
  
  const select = document.getElementById('product-select');
  if (select) {
    select.value = b.product_id || "";
    if (select._ussInstance) {
      select._ussInstance.updateOptions();
    } else if (window.UniversalSearchSelect) {
      new UniversalSearchSelect(select);
    }
  }
  
  currentLines = (b.production_ingredients || []).map(ing => {
    const isIncrease = ing.quantity_used < 0;
    return {
      id: ing.id,
      inventory_id: ing.inventory_id,
      quantity: Math.abs(ing.quantity_used),
      action: isIncrease ? 'INCREASE' : 'DECREASE'
    };
  });
  
  renderIngredientsTable();
  APP.openModal('production-modal');
}

function addIngredientRow() {
  currentLines.push({ id: 'new-' + Date.now(), inventory_id: '', quantity: 0, action: 'DECREASE' });
  renderIngredientsTable();
}

function removeIngredientRow(idx) {
  currentLines.splice(idx, 1);
  renderIngredientsTable();
}

function updateIngredient(idx, field, value) {
  currentLines[idx][field] = value;
  
  if (field === 'inventory_id') {
    const inv = cachedInventory.find(i => i.id == value);
    if (inv) {
      currentLines[idx].unit = inv.unit || 'Kg';
    }
  }
  
  renderIngredientsTable();
}

function renderIngredientsTable() {
  const tbody = document.getElementById('ingredients-tbody');
  if (!tbody) return;
  
  if (currentLines.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4" style="text-align:center; padding:15px; color:var(--text-muted); font-size:13px;">No items added.</td></tr>';
    return;
  }
  
  const options = '<option value="">Select Inventory Item</option>' + cachedInventory.map(i => `<option value="${i.id}">${i.name}</option>`).join('');
  
  tbody.innerHTML = currentLines.map((line, idx) => {
    const inv = cachedInventory.find(i => i.id == line.inventory_id);
    const unitLabel = line.unit || (inv ? inv.unit : '');
    
    return `<tr>
      <td>
        <span class="mobile-label">Inventory Item</span>
        <select class="form-select uss-inventory-select" onchange="updateIngredient(${idx}, 'inventory_id', this.value)">
          ${options.replace(`value="${line.inventory_id}"`, `value="${line.inventory_id}" selected`)}
        </select>
      </td>
      <td>
        <span class="mobile-label">Quantity</span>
        <input type="number" class="form-input" style="width: 100%;" min="0.01" step="0.01" value="${line.quantity || ''}" onchange="updateIngredient(${idx}, 'quantity', this.value)">
      </td>
      <td>
        <span class="mobile-label">Unit</span>
        <select class="form-select" onchange="updateIngredient(${idx}, 'unit', this.value)">
          <option value="Kg" ${unitLabel === 'Kg' || unitLabel === 'kg' ? 'selected' : ''}>Kg</option>
          <option value="Litre" ${unitLabel === 'Litre' || unitLabel === 'L' || unitLabel === 'litre' ? 'selected' : ''}>Litre</option>
          <option value="g" ${unitLabel === 'g' || unitLabel === 'G' ? 'selected' : ''}>g</option>
          <option value="ml" ${unitLabel === 'ml' || unitLabel === 'ML' ? 'selected' : ''}>ml</option>
          <option value="Nos" ${unitLabel === 'Nos' || unitLabel === 'nos' ? 'selected' : ''}>Nos</option>
          ${!['Kg', 'Litre', 'g', 'ml', 'Nos', 'kg', 'L', 'litre', 'G', 'ML', 'nos'].includes(unitLabel) && unitLabel ? `<option value="${unitLabel}" selected>${unitLabel}</option>` : ''}
        </select>
      </td>
      <td>
        <span class="mobile-label">Action</span>
        <select class="form-select" style="font-weight: bold; color: ${line.action === 'INCREASE' ? 'var(--success)' : 'var(--danger)'};" onchange="updateIngredient(${idx}, 'action', this.value)">
          <option value="DECREASE" ${line.action === 'DECREASE' ? 'selected' : ''}>DECREASE</option>
          <option value="INCREASE" ${line.action === 'INCREASE' ? 'selected' : ''}>INCREASE</option>
        </select>
      </td>
      <td>
        <span class="mobile-label">Remove</span>
        <button type="button" class="icon-btn delete-btn" style="margin-top: 4px;" onclick="removeIngredientRow(${idx})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
  
  setTimeout(() => {
    if (window.UTILS?.initAllAutocompleteSelects) {
      UTILS.initAllAutocompleteSelects();
    }
  }, 10);
}

async function saveProduction() {
  const d = UTILS.getFormData('production-form');
  if (!d.product_id) { APP.showToast('Product is required', 'error'); return; }
  const qtyProduced = parseFloat(d.quantity_produced);
  if (!qtyProduced || qtyProduced <= 0) { APP.showToast('Valid quantity is required', 'error'); return; }
  
  const validLines = currentLines.filter(i => i.inventory_id && parseFloat(i.quantity) > 0);
  
  try {
    const prodObj = cachedProducts.find(p => p.id == d.product_id);
    let finalBatchNo = d.batch_no;
    if (!finalBatchNo) {
      finalBatchNo = await getNextProductionBatchNo();
    }
    
    const payload = {
      product_id: parseInt(d.product_id),
      product_name: prodObj ? prodObj.name : '',
      batch_no: finalBatchNo,
      batch_size: qtyProduced,
      batch_unit: 'Kg',
      date: d.date,
      status: 'Completed',
      notes: d.notes || '',
      total_quantity: qtyProduced
    };
    
    let savedId = editingProductionId;
    
    if (editingProductionId) {
      const { error } = await window.dbClient.from('formulations').update(payload).eq('id', editingProductionId);
      if (error) throw error;
      
      await window.dbClient.from('formulation_ingredients').delete().eq('formulation_id', editingProductionId);
    } else {
      const { data, error } = await window.dbClient.from('formulations').insert([payload]).select();
      if (error) throw error;
      savedId = data[0].id;
    }
    
    if (validLines.length > 0) {
      const ingPayload = validLines.map(line => {
        const invObj = cachedInventory.find(i => i.id == line.inventory_id);
        const qty = parseFloat(line.quantity) || 0;
        const finalQty = line.action === 'INCREASE' ? -qty : qty;
        
        return {
          formulation_id: savedId,
          product_id: parseInt(line.inventory_id),
          product_name: invObj ? invObj.name : '',
          quantity: finalQty,
          unit: line.unit || (invObj ? invObj.unit : 'Kg')
        };
      });
      const { error: ingErr } = await window.dbClient.from('formulation_ingredients').insert(ingPayload);
      if (ingErr) throw ingErr;
    }
    
    APP.showToast('Production batch saved successfully!', 'success');
    APP.closeModal('production-modal');
    loadData();
    
  } catch (err) {
    console.error(err);
    APP.showToast('Error saving: ' + err.message, 'error');
  }
}

async function deleteProduction(id) {
  APP.showConfirm('Delete this production batch?', async () => {
    try {
      const { error } = await window.dbClient.from('formulations').delete().eq('id', id);
      if (error) throw error;
      
      APP.showToast('Production batch deleted!', 'success');
      loadData();
    } catch (e) {
      console.error(e);
      APP.showToast('Delete failed: ' + e.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('production-search-input')?.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    const filtered = allProductions.filter(b => 
      (b.batch_no || '').toLowerCase().includes(term) ||
      (b.product_name || '').toLowerCase().includes(term)
    );
    renderTable(filtered);
  });
  
  setTimeout(() => loadData(), 100);
});
