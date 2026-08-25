// One definition per player-facing message, rendered for whichever channel is
// active:
//
//   email    -> `subject` + `html` (rich, no approval process)
//   whatsapp -> `templateName` + `params`, which must match a template Meta has
//               pre-approved (see docs/whatsapp-setup.md)
//   sms      -> `preview`, plain text
//
// Keeping all three on one object means a channel switch is an env change and
// nothing here moves.
//
// ---------------------------------------------------------------------------
// WhatsApp template registration (only needed if MESSAGING_CHANNEL=whatsapp).
// Category: UTILITY. Language: English. Paste the Body exactly.
//
//   Name: buy_in_approved
//   Body: Hi {{1}}, your buy-in of {{2}} has been approved at {{3}}.
//         Good luck at the table!
//
//   Name: session_settled
//   Body: Hi {{1}}, {{2}} at {{3}} has been settled. {{4}} Bought in: {{5}},
//         cashed out: {{6}}. Your standing at {{3}} to date: {{7}}.
// ---------------------------------------------------------------------------

export const TEMPLATE_LANGUAGE = 'en';

export interface OutboundMessage {
  /** Email subject line. */
  subject: string;
  /** Email body (HTML). */
  html: string;
  /** WhatsApp template registered with Meta. */
  templateName: string;
  /** Ordered body parameters for {{1}}, {{2}}, ... */
  params: string[];
  /** Plain-text rendering — SMS, and no-op logging. */
  preview: string;
}

const BRAND = 'The House Keeps Score';

// Inline styles and table layout throughout: email clients strip <style>
// blocks and have patchy flexbox support.
function shell(bodyHtml: string): string {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#0a150e;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a150e;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0f2116;border:1px solid #4a3d1e;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <tr><td style="padding:22px 26px 14px;border-bottom:1px solid #4a3d1e;">
          <div style="font-size:17px;font-weight:800;color:#d4af37;letter-spacing:0.3px;">&#9824; ${BRAND}</div>
        </td></tr>
        ${bodyHtml}
        <tr><td style="padding:16px 26px 22px;border-top:1px solid #4a3d1e;">
          <div style="font-size:11px;color:#5e6e63;line-height:1.5;">
            Sent automatically by ${BRAND}. Figures shown are your own only.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function statRow(label: string, value: string, color = '#f5f3ea'): string {
  return `<tr>
    <td style="padding:7px 0;font-size:13px;color:#93a296;">${label}</td>
    <td style="padding:7px 0;font-size:13px;font-weight:700;color:${color};text-align:right;white-space:nowrap;">${value}</td>
  </tr>`;
}

export function buyInApprovedMessage(args: {
  firstName: string;
  amount: string;
  clubName: string;
}): OutboundMessage {
  return {
    subject: `Buy-in approved — ${args.amount} at ${args.clubName}`,
    html: shell(`<tr><td style="padding:22px 26px;">
      <p style="margin:0 0 14px;font-size:15px;color:#f5f3ea;">Hi ${args.firstName},</p>
      <p style="margin:0 0 18px;font-size:14px;color:#93a296;line-height:1.6;">
        Your buy-in has been approved at <strong style="color:#f5f3ea;">${args.clubName}</strong>.
      </p>
      <div style="background:#0a150e;border:1px solid #4a3d1e;border-radius:12px;padding:16px;text-align:center;">
        <div style="font-size:11px;color:#93a296;text-transform:uppercase;letter-spacing:1px;">Approved</div>
        <div style="font-size:26px;font-weight:800;color:#d4af37;margin-top:4px;">${args.amount}</div>
      </div>
      <p style="margin:18px 0 0;font-size:14px;color:#93a296;">Good luck at the table.</p>
    </td></tr>`),
    templateName: 'buy_in_approved',
    params: [args.firstName, args.amount, args.clubName],
    preview:
      `Hi ${args.firstName}, your buy-in of ${args.amount} has been approved at ` +
      `${args.clubName}. Good luck at the table!`,
  };
}

export function sessionSettledMessage(args: {
  firstName: string;
  sessionName: string;
  clubName: string;
  /** e.g. "You won 2,400 Chips this session." — never another player's figures. */
  resultLine: string;
  bankIn: string;
  cashedOut: string;
  netResult: number;
  standing: string;
  /** Own position only, e.g. "3rd of 8". */
  rank: string;
}): OutboundMessage {
  const won = args.netResult > 0;
  const resultColor = args.netResult === 0 ? '#f5f3ea' : won ? '#34d399' : '#f87171';

  return {
    subject: `${args.sessionName} settled — your result at ${args.clubName}`,
    html: shell(`<tr><td style="padding:22px 26px;">
      <p style="margin:0 0 14px;font-size:15px;color:#f5f3ea;">Hi ${args.firstName},</p>
      <p style="margin:0 0 18px;font-size:14px;color:#93a296;line-height:1.6;">
        <strong style="color:#f5f3ea;">${args.sessionName}</strong> at
        <strong style="color:#f5f3ea;">${args.clubName}</strong> has been settled.
      </p>

      <div style="background:#0a150e;border:1px solid #4a3d1e;border-radius:12px;padding:18px;text-align:center;">
        <div style="font-size:11px;color:#93a296;text-transform:uppercase;letter-spacing:1px;">This session</div>
        <div style="font-size:28px;font-weight:800;color:${resultColor};margin-top:4px;">${args.resultLine}</div>
      </div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
        ${statRow('Bought in', args.bankIn)}
        ${statRow('Cashed out', args.cashedOut)}
      </table>

      <div style="height:1px;background:#4a3d1e;margin:20px 0;"></div>

      <div style="font-size:11px;color:#93a296;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">All time at this club</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${statRow(`Standing at ${args.clubName}`, args.standing, '#d4af37')}
        ${statRow(`Rank at ${args.clubName}`, args.rank, '#d4af37')}
      </table>
    </td></tr>`),
    templateName: 'session_settled',
    params: [
      args.firstName,
      args.sessionName,
      args.clubName,
      args.resultLine,
      args.bankIn,
      args.cashedOut,
      args.standing,
    ],
    preview:
      `Hi ${args.firstName}, ${args.sessionName} at ${args.clubName} has been settled. ` +
      `${args.resultLine} Bought in: ${args.bankIn}, cashed out: ${args.cashedOut}. ` +
      `Your standing at ${args.clubName} to date: ${args.standing} (${args.rank}).`,
  };
}

/**
 * The answer to a request to join a club.
 *
 * One template for both outcomes rather than two, because the difference is a
 * sentence and the shape is identical — and because a rejection that looks
 * structurally different from an acceptance reads as an afterthought.
 *
 * A rejection says nothing about why. The app does not collect a reason, and
 * inventing a neutral one ("the club is full") would be a guess presented to
 * the person it is about.
 */
export function joinRequestDecidedMessage(args: {
  firstName: string;
  clubName: string;
  accepted: boolean;
}): OutboundMessage {
  const headline = args.accepted ? 'You are in' : 'Not this time';
  return {
    subject: args.accepted
      ? `You have joined ${args.clubName}`
      : `Your request to join ${args.clubName}`,
    html: shell(`<tr><td style="padding:22px 26px;">
      <p style="margin:0 0 14px;font-size:15px;color:#f5f3ea;">Hi ${args.firstName},</p>
      <p style="margin:0 0 18px;font-size:14px;color:#93a296;line-height:1.6;">
        ${
          args.accepted
            ? `Your request to join <strong style="color:#f5f3ea;">${args.clubName}</strong> was accepted. You can see the club and its history now.`
            : `Your request to join <strong style="color:#f5f3ea;">${args.clubName}</strong> was not accepted.`
        }
      </p>
      <div style="background:#0a150e;border:1px solid #4a3d1e;border-radius:12px;padding:16px;text-align:center;">
        <div style="font-size:11px;color:#93a296;text-transform:uppercase;letter-spacing:1px;">${headline}</div>
        <div style="font-size:20px;font-weight:800;color:#d4af37;margin-top:4px;">${args.clubName}</div>
      </div>
    </td></tr>`),
    templateName: args.accepted ? 'join_request_accepted' : 'join_request_rejected',
    params: [args.firstName, args.clubName],
    preview: args.accepted
      ? `Hi ${args.firstName}, your request to join ${args.clubName} was accepted.`
      : `Hi ${args.firstName}, your request to join ${args.clubName} was not accepted.`,
  };
}
