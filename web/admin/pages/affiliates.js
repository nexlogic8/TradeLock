import { html } from '/js/core/dom.js';
import { get } from '/js/core/api.js';
import { paise, int } from '/js/core/format.js';
import { icon } from '/js/ui/icons.js';
import { empty } from '/js/ui/parts.js';
import { kpi } from './ui.js';

export default {
  sub: 'Referral links, sign-ups they brought and commissions earned.',

  load: () => get('/admin/affiliates'),

  view({ data: d }) {
    const s = d.stats;
    const clicks = d.items.reduce((n, a) => n + a.clicks, 0);
    return html`
      <div class="kpis">
        ${kpi('Link clicks', int(clicks), 'All affiliate links')}
        ${kpi('Referred sign-ups', int(s.referrals), clicks ? `${Math.round((s.referrals / clicks) * 100)}% of clicks` : '')}
        ${kpi('Paying referrals', int(s.activeReferrals), '', 'pos')}
        ${kpi('Commissions · 30 days', paise(s.commissions30d))}
      </div>
      <div class="panel pad">
        <div class="panel-head"><h3 class="panel-title">${icon('share')} Affiliates</h3><span class="muted small">${d.items.length}</span></div>
        ${d.items.length ? html`<div class="tbl-wrap"><table class="tbl cards">
          <thead><tr><th>Affiliate</th><th>Code</th><th class="r">Clicks</th><th class="r">Sign-ups</th><th class="r">Paying</th><th class="r">Earned</th><th class="r">Balance</th></tr></thead>
          <tbody>${d.items.map(a => html`<tr>
            <td class="span"><b>${a.name}</b><div class="tiny dim">${a.email}</div></td>
            <td class="num">${a.code}</td>
            <td class="r num">${int(a.clicks)}</td>
            <td class="r num">${int(a.signups)}</td>
            <td class="r num">${int(a.paying)}</td>
            <td class="r num">${paise(a.earned)}</td>
            <td class="r num">${paise(a.balance)}</td>
          </tr>`)}</tbody></table></div>` : empty('share', 'No affiliates yet', 'Users get a referral link when they open the Affiliate hub.')}
      </div>`;
  },
};
