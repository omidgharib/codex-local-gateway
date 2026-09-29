export async function loadUser(fetchUser, userId) {
  const user = await fetchUser(userId);
  return user.name.toUpperCase();
}
