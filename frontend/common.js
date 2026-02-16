
const API = 'http://localhost:3000'; // Adjust to your backend URL

// Map of services and whether they are physical
// Matching backend SERVICES_CONFIG keys exactly
const SERVICE_MAP = {
  "קידוד": "physical",
  "טופס חו\"ל": "physical",
  "אישור הוצל\"א": "physical",
  "טופס טיולים - יוצא": "physical",
  "השחרה": "digital",
  "אישור כניסה קבוע": "digital",
  "אישור כניסה לקבלן/אזרח/לקבלת שירות מהב\"ם": "digital",
  "אישור בניהול זהויות": "digital",
  "טופס טיולים - נכנס": "digital"
};

async function getAvailability(date, serviceType, details = {}) {
  try {
    const url = new URL(API + '/availability');
    url.searchParams.set('date', date);
    url.searchParams.set('serviceType', serviceType);
    if (details && Object.keys(details).length) {
      url.searchParams.set('details', JSON.stringify(details));
    }
    const r = await fetch(url);
    return await r.json();
  } catch (e) {
    return { success: false, message: 'Network error' };
  }
}

async function postBook(payload) {
  try {
    const r = await fetch(API + '/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await r.json();
  } catch (e) {
    return { success: false, message: 'Network error' };
  }
}

// Helper to init booking form on a service page
function initBookingForm(serviceName) {
  const type = SERVICE_MAP[serviceName] || 'digital';
  const form = document.querySelector('form');
  if (!form) return;

  const dateInput = form.querySelector('input[name="date"]');
  const timeSelect = form.querySelector('select[name="time"]');

  if (type === 'physical') {
    // Physical service: enable date/time selection
    if (dateInput && timeSelect) {
      dateInput.addEventListener('change', async () => {
        const dateVal = dateInput.value;
        if (!dateVal) return;
        const details = collectDetails(form);
        const avail = await getAvailability(dateVal, serviceName, details);
        timeSelect.innerHTML = '';
        if (avail.success && avail.available.length) {
          avail.available.forEach(iso => {
            const dt = new Date(iso);
            const opt = document.createElement('option');
            opt.value = iso;
            opt.textContent = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            timeSelect.appendChild(opt);
          });
        } else {
          const opt = document.createElement('option');
          opt.textContent = 'No available times';
          opt.disabled = true;
          timeSelect.appendChild(opt);
        }
      });
    }
  } else {
    // Digital service: hide time/date pickers if present
    if (dateInput) dateInput.closest('.form-group')?.remove();
    if (timeSelect) timeSelect.closest('.form-group')?.remove();
  }

  // Form submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const details = collectDetails(form);
    const payload = { serviceType: serviceName, details };

    if (type === 'physical') {
      const selectedISO = timeSelect?.value;
      if (!selectedISO) {
        alert('Please select a time');
        return;
      }
      payload.startTime = selectedISO;
    }

    const res = await postBook(payload);
    if (res.success) {
      alert(`Booked successfully!\nStart: ${res.startTime}\nEnd: ${res.endTime}`);
      window.location.href = 'success.html';
    } else {
      alert(res.message || 'Booking failed');
    }
  });
}

// Helper to gather form inputs into details object
function collectDetails(form) {
  const data = {};
  form.querySelectorAll('input, select, textarea').forEach(el => {
    if (!el.name || el.name === 'date' || el.name === 'time') return;
    if (el.type === 'checkbox') {
      data[el.name] = el.checked;
    } else if (el.type === 'number') {
      data[el.name] = parseInt(el.value, 10) || 0;
    } else {
      data[el.name] = el.value;
    }
  });
  return data;
}
