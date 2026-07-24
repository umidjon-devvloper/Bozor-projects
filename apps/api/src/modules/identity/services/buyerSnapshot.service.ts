import { userRepository } from '../repositories/user.repository.js';

/**
 * The buyer's name and phone as an order should freeze them.
 *
 * Exposed as a purpose-built function rather than the user repository, so the orders module
 * asks identity a question it owns the answer to instead of reaching through its data layer
 * (ADR-0011 rule 1). It also keeps the snapshot's shape in one place: if orders ever need a
 * second contact field, it is added here rather than reconstructed at three call sites.
 */
export async function buyerSnapshot(
  userId: string,
): Promise<{ name: string; phone: string } | null> {
  const user = await userRepository.findById(userId);
  if (!user) return null;
  const profile = await userRepository.getProfile(userId);
  const name = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ').trim();
  return { name: name.length > 0 ? name : 'Buyer', phone: user.phone };
}
