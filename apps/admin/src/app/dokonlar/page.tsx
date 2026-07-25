'use client';

import { useQuery } from '@tanstack/react-query';
import { formatSom } from '@bozorlar/api-client';
import { useApi, useSession } from '@bozorlar/session';

/**
 * Sellers, ranked by what they sold — with the dispute rate beside it.
 *
 * The ranking on its own would be a leaderboard, and a leaderboard is a bad tool for the
 * decision this table exists for. A stall selling twice as much as anyone else while
 * generating five times the disputes is not the platform's best seller; the second column is
 * what turns the first one into something worth acting on.
 */
export default function SellersPage() {
  const api = useApi();
  const { status } = useSession();

  const sellers = useQuery({
    queryKey: ['admin-sellers'],
    queryFn: () => api.admin.sellers().then((response) => response.data),
    enabled: status === 'signed-in',
  });

  if (status === 'signed-out') {
    return <Shell><a href="/kirish" className="font-body text-sm text-tile hover:underline">Kirish</a></Shell>;
  }

  return (
    <Shell>
      {sellers.isPending ? (
        <p className="font-body text-sm text-ink/50 dark:text-paper/50">Yuklanmoqda…</p>
      ) : sellers.isError || !sellers.data ? (
        <p role="alert" className="font-body text-sm text-pomegranate">Ro'yxatni ochib bo'lmadi.</p>
      ) : sellers.data.sellers.length === 0 ? (
        <p className="font-body text-sm text-ink/55 dark:text-paper/55">
          Bu davrda yakunlangan buyurtma bo'lmagan.
        </p>
      ) : (
        <table className="w-full text-left font-body text-sm">
          <thead>
            <tr className="border-b border-ink/10 text-xs text-ink/45 dark:border-paper/10 dark:text-paper/45">
              <th scope="col" className="pb-2 font-normal">Do'kon</th>
              <th scope="col" className="pb-2 text-right font-normal">Buyurtma</th>
              <th scope="col" className="pb-2 text-right font-normal">Savdo</th>
              <th scope="col" className="pb-2 text-right font-normal">Nizo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink/5 dark:divide-paper/5">
            {sellers.data.sellers.map((seller) => {
              // A tenth of orders disputed is not a rounding error, it is a pattern.
              const risky = seller.disputeRateBp !== null && seller.disputeRateBp >= 1000;
              return (
                <tr key={seller.shopId}>
                  <td className="py-2.5 text-ink dark:text-paper">
                    {typeof seller.name === 'string' ? seller.name : seller.shopId}
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-ink/70 dark:text-paper/70">
                    {seller.orders}
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-ink dark:text-paper">
                    {formatSom(seller.gmvMinor)}
                  </td>
                  <td
                    className={
                      risky
                        ? 'py-2.5 text-right tabular-nums text-pomegranate'
                        : 'py-2.5 text-right tabular-nums text-ink/60 dark:text-paper/60'
                    }
                  >
                    {seller.disputes}
                    {seller.disputeRateBp !== null
                      ? ` · ${(seller.disputeRateBp / 100).toFixed(1)}%`
                      : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-8 sm:px-8">
      <h1 className="mb-2 font-display text-2xl font-bold text-ink dark:text-paper">Do'konlar</h1>
      <p className="mb-8 font-body text-sm text-ink/55 dark:text-paper/55">
        Oxirgi 30 kun, savdo bo'yicha tartiblangan.
      </p>
      {children}
    </main>
  );
}
