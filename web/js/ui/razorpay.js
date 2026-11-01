// Razorpay Checkout, shared by wallet top-ups and subscription payments.
// While it is open TradeLock stays visible behind it, blurred (see .paying in pages.css); Razorpay's
// own backdrop is transparent so it doesn't cover the page in white.
let loading = null;

function loadScript() {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error('Could not load the payment window. Check your connection.')); };
    document.head.append(s);
  });
  return loading;
}

const setPaying = on => document.documentElement.classList.toggle('paying', on);

/** Opens Checkout for an order from the server; resolves with Razorpay's signed response. */
export async function payWithRazorpay(order, description) {
  await loadScript();
  return new Promise((resolve, reject) => {
    const done = fn => arg => { setPaying(false); fn(arg); };
    const rz = new window.Razorpay({
      key: order.keyId, amount: order.amount, currency: 'INR', order_id: order.orderId,
      name: 'TradeLock', description, prefill: { name: order.name, email: order.email, contact: order.contact },
      theme: { color: '#1FC995', backdrop_color: '#05090F00' },
      // Inside the TradeLock Android app: show UPI (GPay, PhonePe, Paytm...). The app opens upi:// links
      // in the chosen UPI app; Razorpay hides UPI in app web views unless told this works.
      ...(window.TradeLockApp && { webview_intent: true }),
      handler: done(resolve),
      modal: { ondismiss: done(() => reject(new Error('Payment cancelled.'))) },
    });
    rz.on('payment.failed', done(e => reject(new Error(e?.error?.description || 'Payment failed.'))));
    setPaying(true);
    rz.open();
  });
}

/** Checkout + server-side signature verification in one step. */
export async function payAndVerify(post, order, description) {
  const r = await payWithRazorpay(order, description);
  return post('/wallet/topup/verify', { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature });
}
