'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, formatSom } from '@bozorlar/api-client';
import type { AdminDispute, SellerApplication } from '@bozorlar/api-client';
import type { ProductResponse } from '@bozorlar/contracts';
import { useApi, useSession } from '@bozorlar/session';

/**
 * The three queues, worked rather than counted.
 *
 * The dashboard reports how deep each queue is; this is where it is emptied. They share a page
 * because they share a rhythm — a moderator sits down once and clears whatever arrived — and
 * splitting them across three screens would mean checking three places to learn there is
 * nothing to do.
 *
 * Every refusal takes a written reason. The reason reaches the seller or the buyer and is kept,
 * so it is the only part of a rejection that person will actually read; "rejected" with no
 * explanation produces a support call and a resubmission of the same thing.
 */
export default function QueuesPage() {
  const { status } = useSession();

  if (status === 'signed-out') {
    return (
      <Shell>
        <a href="/kirish" className="font-body text-sm text-tile hover:underline">Kirish</a>
      </Shell>
    );
  }

  return (
    <Shell>
      <ProductQueue />
      <ShopQueue />
      <ApplicationQueue />
      <DisputeQueue />
    </Shell>
  );
}

/* ------------------------------------------------------------------ products */

function ProductQueue() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['product-queue'],
    queryFn: () => api.admin.productQueue({ limit: 50 }).then((response) => response.data),
  });

  const moderate = useMutation({
    mutationFn: (input: { id: string; approved: boolean; reason?: string }) =>
      api.admin.moderateProduct(input.id, input.approved, input.reason),
    onSuccess: () => {
      setRejecting(null);
      setReason('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['product-queue'] });
      void queryClient.invalidateQueries({ queryKey: ['moderation'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Bajarilmadi.'),
  });

  return (
    <Section title="Mahsulot moderatsiyasi" count={queue.data?.length} query={queue}>
      {queue.data?.map((product: ProductResponse) => (
        <Row key={product.id}>
          <div className="min-w-0">
            <p className="font-display text-base text-ink dark:text-paper">
              {typeof product.name === 'string' ? product.name : ''}
            </p>
            <p className="mt-1 font-body text-xs text-ink/55 dark:text-paper/55">
              {formatSom(product.price.amount)} so'm/{product.availableQty.unit}
            </p>
          </div>

          {rejecting === product.id ? (
            <ReasonForm
              placeholder="Nima uchun rad etilyapti — sotuvchi shuni o'qiydi"
              value={reason}
              onChange={setReason}
              onCancel={() => setRejecting(null)}
              onSubmit={() => moderate.mutate({ id: product.id, approved: false, reason })}
              busy={moderate.isPending}
            />
          ) : (
            <div className="flex shrink-0 gap-2">
              <Approve onClick={() => moderate.mutate({ id: product.id, approved: true })} busy={moderate.isPending} />
              <Reject onClick={() => setRejecting(product.id)} />
            </div>
          )}
        </Row>
      ))}
      {error ? <Alert>{error}</Alert> : null}
    </Section>
  );
}

/* --------------------------------------------------------------------- shops */

/**
 * Shops awaiting review.
 *
 * The backend had the index for this queue from the day the module was written and never
 * exposed a way to read it, so a shop submitted for moderation waited until somebody looked it
 * up by id. It is a queue now.
 */
function ShopQueue() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['shop-queue'],
    queryFn: () => api.admin.shopQueue({ limit: 50 }).then((response) => response.data),
  });

  const moderate = useMutation({
    mutationFn: (input: { id: string; approved: boolean; reason?: string }) =>
      api.admin.moderateShop(input.id, input.approved, input.reason),
    onSuccess: () => {
      setRejecting(null);
      setReason('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['shop-queue'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Bajarilmadi.'),
  });

  return (
    <Section title="Do'kon moderatsiyasi" count={queue.data?.length} query={queue}>
      {queue.data?.map((shop) => (
        <Row key={shop.id}>
          <div className="min-w-0">
            <p className="font-display text-base text-ink dark:text-paper">
              {typeof shop.name === 'string' ? shop.name : shop.slug}
            </p>
            <p className="mt-1 font-body text-xs text-ink/55 dark:text-paper/55">
              {[shop.sectionCode, shop.stallNo ? `${shop.stallNo}-do'kon` : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>

          {rejecting === shop.id ? (
            <ReasonForm
              placeholder="Nima to'g'rilanishi kerak — sotuvchi shuni o'qiydi"
              value={reason}
              onChange={setReason}
              onCancel={() => setRejecting(null)}
              onSubmit={() => moderate.mutate({ id: shop.id, approved: false, reason })}
              busy={moderate.isPending}
            />
          ) : (
            <div className="flex shrink-0 gap-2">
              <Approve onClick={() => moderate.mutate({ id: shop.id, approved: true })} busy={moderate.isPending} />
              <Reject onClick={() => setRejecting(shop.id)} />
            </div>
          )}
        </Row>
      ))}
      {error ? <Alert>{error}</Alert> : null}
    </Section>
  );
}

/* -------------------------------------------------------------- applications */

function ApplicationQueue() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['applications'],
    queryFn: () => api.admin.applications({ limit: 50 }).then((response) => response.data),
  });

  const done = () => {
    setRejecting(null);
    setReason('');
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ['applications'] });
    void queryClient.invalidateQueries({ queryKey: ['moderation'] });
  };
  const fail = (caught: unknown) =>
    setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Bajarilmadi.');

  const claim = useMutation({ mutationFn: (id: string) => api.admin.claimApplication(id), onSuccess: done, onError: fail });
  const approve = useMutation({ mutationFn: (id: string) => api.admin.approveApplication(id), onSuccess: done, onError: fail });
  const reject = useMutation({
    mutationFn: (id: string) => api.admin.rejectApplication(id, reason),
    onSuccess: done,
    onError: fail,
  });

  return (
    <Section title="Sotuvchi arizalari" count={queue.data?.length} query={queue}>
      {queue.data?.map((application: SellerApplication) => (
        <Row key={application.id}>
          <div className="min-w-0">
            <p className="font-display text-base text-ink dark:text-paper">
              {application.applicantName ?? application.phone ?? application.id}
            </p>
            <p className="mt-1 font-body text-xs text-ink/55 dark:text-paper/55">
              {application.status}
              {' · '}
              {new Date(application.createdAt).toLocaleDateString('uz')}
            </p>
          </div>

          {rejecting === application.id ? (
            <ReasonForm
              placeholder="Nima yetishmayapti — ariza beruvchi shuni o'qiydi"
              value={reason}
              onChange={setReason}
              onCancel={() => setRejecting(null)}
              onSubmit={() => reject.mutate(application.id)}
              busy={reject.isPending}
            />
          ) : (
            <div className="flex shrink-0 gap-2">
              {/*
                Claiming is not a formality: it marks who is reviewing so two moderators do not
                work the same application and reach different answers.
              */}
              {application.status === 'SUBMITTED' ? (
                <button
                  type="button"
                  onClick={() => claim.mutate(application.id)}
                  disabled={claim.isPending}
                  className="rounded-stall border border-ink/15 px-3 py-2 font-body text-sm text-ink/70 hover:text-tile disabled:opacity-50 dark:border-paper/15 dark:text-paper/70"
                >
                  Ko'rib chiqaman
                </button>
              ) : null}
              <Approve onClick={() => approve.mutate(application.id)} busy={approve.isPending} />
              <Reject onClick={() => setRejecting(application.id)} />
            </div>
          )}
        </Row>
      ))}
      {error ? <Alert>{error}</Alert> : null}
    </Section>
  );
}

/* ------------------------------------------------------------------ disputes */

const OUTCOMES = [
  { value: 'RESOLVED_SELLER', label: "Sotuvchi foydasiga" },
  { value: 'REFUND_FULL', label: "To'liq qaytarish" },
  { value: 'REFUND_PARTIAL', label: 'Qisman qaytarish' },
];

function DisputeQueue() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [outcome, setOutcome] = useState('RESOLVED_SELLER');
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState('');
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['disputes'],
    queryFn: () => api.admin.disputes({ limit: 50 }).then((response) => response.data),
  });

  const resolve = useMutation({
    mutationFn: (id: string) =>
      api.admin.resolveDispute(
        id,
        outcome,
        reason,
        outcome === 'REFUND_PARTIAL' ? String(BigInt(refund.replace(/\D/g, '') || '0') * 100n) : undefined,
      ),
    onSuccess: () => {
      setOpen(null);
      setReason('');
      setRefund('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['disputes'] });
      void queryClient.invalidateQueries({ queryKey: ['moderation'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Bajarilmadi.'),
  });

  return (
    <Section title="Nizolar" count={queue.data?.length} query={queue}>
      {queue.data?.map((dispute: AdminDispute) => (
        <div
          key={dispute.id}
          className="rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="font-body text-xs tabular-nums text-ink/50 dark:text-paper/50">
              {dispute.disputeNo}
              {dispute.orderNo ? ` · ${dispute.orderNo}` : ''}
            </span>
            <span className="font-body text-xs text-ink/55 dark:text-paper/55">{dispute.reason}</span>
          </div>

          {/* The buyer's own words. A decision made without reading them is a coin toss. */}
          <p className="mt-3 font-body text-sm leading-relaxed text-ink dark:text-paper">
            {dispute.claim}
          </p>

          {dispute.claimedAmount ? (
            <p className="mt-2 font-body text-xs text-ink/55 dark:text-paper/55">
              Talab qilingan: {formatSom(dispute.claimedAmount.amount)} so'm
            </p>
          ) : null}

          {open === dispute.id ? (
            <div className="mt-4 space-y-3">
              <select
                value={outcome}
                onChange={(event) => setOutcome(event.target.value)}
                aria-label="Qaror"
                className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
              >
                {OUTCOMES.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>

              {outcome === 'REFUND_PARTIAL' ? (
                <input
                  value={refund}
                  onChange={(event) => setRefund(event.target.value)}
                  inputMode="numeric"
                  placeholder="Qaytariladigan summa (so'm)"
                  className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 text-right font-display text-sm tabular-nums text-ink dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
                />
              ) : null}

              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                placeholder="Qaror sababi — ikkala tomon ham o'qiydi va yozuvda qoladi"
                className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2.5 font-body text-sm text-ink placeholder:text-ink/30 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
              />

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => resolve.mutate(dispute.id)}
                  disabled={reason.trim().length < 10 || resolve.isPending}
                  className="rounded-stall bg-tile px-4 py-2 font-display text-sm text-paper hover:bg-tile-deep disabled:opacity-50"
                >
                  {resolve.isPending ? '…' : 'Qaror qabul qilish'}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(null)}
                  className="rounded-stall px-3 py-2 font-body text-sm text-ink/60 dark:text-paper/60"
                >
                  Bekor qilish
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(dispute.id)}
              className="mt-4 rounded-stall border border-ink/15 px-3 py-2 font-body text-sm text-ink/70 hover:text-tile dark:border-paper/15 dark:text-paper/70"
            >
              Ko'rib chiqish
            </button>
          )}
        </div>
      ))}
      {error ? <Alert>{error}</Alert> : null}
    </Section>
  );
}

/* -------------------------------------------------------------------- shared */

function Section({
  title,
  count,
  query,
  children,
}: {
  title: string;
  count: number | undefined;
  query: { isPending: boolean; isError: boolean };
  children: React.ReactNode;
}) {
  return (
    <section className="mb-14">
      <h2 className="mb-4 font-display text-base font-medium text-ink dark:text-paper">
        {title}
        {count !== undefined ? (
          <span className="ml-2 font-body text-sm text-ink/45 dark:text-paper/45">{count}</span>
        ) : null}
      </h2>

      {query.isPending ? (
        <p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p>
      ) : query.isError ? (
        <Alert>Ro'yxatni ochib bo'lmadi.</Alert>
      ) : count === 0 ? (
        <p className="rounded-stall border border-dashed border-ink/15 px-4 py-8 text-center font-body text-sm text-ink/50 dark:border-paper/15 dark:text-paper/50">
          Navbat bo'sh
        </p>
      ) : (
        <div className="space-y-3">{children}</div>
      )}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-stall border border-ink/10 bg-white/60 p-4 dark:border-paper/10 dark:bg-paper/5">
      {children}
    </div>
  );
}

function Approve({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-stall bg-tile px-3.5 py-2 font-display text-sm text-paper hover:bg-tile-deep disabled:opacity-50"
    >
      Tasdiqlash
    </button>
  );
}

function Reject({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-stall border border-pomegranate/30 px-3.5 py-2 font-body text-sm text-pomegranate hover:bg-pomegranate/5"
    >
      Rad etish
    </button>
  );
}

/** A refusal without a reason is a refusal the other person cannot act on. */
function ReasonForm({
  placeholder,
  value,
  onChange,
  onCancel,
  onSubmit,
  busy,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-stall border border-ink/15 bg-white px-3 py-2 font-body text-sm text-ink placeholder:text-ink/30 sm:w-80 dark:border-paper/15 dark:bg-paper/5 dark:text-paper"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={value.trim().length < 10 || busy}
          className="rounded-stall bg-pomegranate px-3.5 py-2 font-display text-sm text-paper hover:opacity-90 disabled:opacity-50"
        >
          Yuborish
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-stall px-3 py-2 font-body text-sm text-ink/60 dark:text-paper/60"
        >
          Bekor
        </button>
      </div>
    </div>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="mt-3 font-body text-sm text-pomegranate">
      {children}
    </p>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-8 sm:px-8">
      <h1 className="mb-8 font-display text-2xl font-bold text-ink dark:text-paper">Navbatlar</h1>
      {children}
    </main>
  );
}
