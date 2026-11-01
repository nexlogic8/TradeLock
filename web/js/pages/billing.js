// Subscription: plan status, validity, payment and billing summary.
import { get } from '../core/api.js';
import { store } from '../core/store.js';
import { subscriptionPanel, bindSubscription } from '../ui/subscription.js';

export default {
  title: 'Subscription',
  sub: 'Your plan, validity and payments',
  layout: 'app',
  auth: true,

  async load() {
    const billing = await get('/billing');
    store.set({ user: { ...store.get().user, subscription: billing.subscription } });
    return { billing };
  },

  view: ctx => subscriptionPanel(ctx, ctx.data.billing.subscription),

  mount: bindSubscription,
};
