//! This host's addresses in the local network, for pairing payloads.

use std::net::Ipv4Addr;

/// Addresses other devices can try: IPv4 addresses of interfaces that are up,
/// except loopback, link-local (169.254/16) and 0.0.0.0, sorted and without
/// repeats. Read afresh for every code, so a new DHCP lease shows up without
/// a restart.
pub fn lan_ipv4_addresses() -> Vec<Ipv4Addr> {
    let interfaces = match if_addrs::get_if_addrs() {
        Ok(interfaces) => interfaces,
        Err(error) => {
            tracing::warn!(%error, "listing network interfaces failed");
            return Vec::new();
        }
    };
    usable(
        interfaces
            .iter()
            .filter_map(|interface| match &interface.addr {
                if_addrs::IfAddr::V4(v4) => Some((v4.ip, interface.is_oper_up())),
                if_addrs::IfAddr::V6(_) => None,
            }),
    )
}

/// The filter behind [`lan_ipv4_addresses`]: `(address, interface is up)`.
pub fn usable(candidates: impl IntoIterator<Item = (Ipv4Addr, bool)>) -> Vec<Ipv4Addr> {
    let mut addresses: Vec<Ipv4Addr> = candidates
        .into_iter()
        .filter(|(ip, up)| *up && !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified())
        .map(|(ip, _)| ip)
        .collect();
    addresses.sort_unstable();
    addresses.dedup();
    addresses
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::usable;

    #[test]
    fn the_real_lan_addresses_are_sorted_deduped_and_exclude_reserved_ranges() {
        // Exercises the actual adapter enumeration (`if_addrs::get_if_addrs`),
        // not just the `usable` filter above: it is the only automated check
        // of the Windows adapter path the CI job for that platform runs. A
        // machine without a LAN reports an empty list, so nothing here
        // depends on an address existing.
        let addresses = super::lan_ipv4_addresses();
        let mut sorted = addresses.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(addresses, sorted, "sorted ascending, without duplicates");
        for address in &addresses {
            assert!(!address.is_loopback(), "loopback address: {address}");
            assert!(!address.is_link_local(), "link-local address: {address}");
            assert!(!address.is_unspecified(), "0.0.0.0: {address}");
        }
    }

    #[test]
    fn only_up_lan_addresses_remain_sorted_without_repeats() {
        let candidates = [
            (Ipv4Addr::new(192, 168, 1, 10), true),
            (Ipv4Addr::new(127, 0, 0, 1), true),
            (Ipv4Addr::new(169, 254, 3, 4), true),
            (Ipv4Addr::new(10, 0, 0, 5), true),
            (Ipv4Addr::new(10, 0, 0, 7), false),
            (Ipv4Addr::new(0, 0, 0, 0), true),
            (Ipv4Addr::new(192, 168, 1, 10), true),
        ];
        assert_eq!(
            usable(candidates),
            vec![Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(192, 168, 1, 10)]
        );
    }
}
