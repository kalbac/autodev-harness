<?php
/**
 * Holds the Woodev_Test_Tracking helper class.
 *
 * @package Woodev_Shipping_Test_Plugin
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'Woodev_Test_Tracking' ) ) :

	/**
	 * Builds carrier tracking URLs for shipped orders.
	 *
	 * @since 1.0.0
	 */
	class Woodev_Test_Tracking {

		/**
		 * The carrier's tracking endpoint, including the scheme and host.
		 *
		 * @since 1.0.0
		 * @var string
		 */
		const TRACKING_BASE_URL = 'https://tracking.example.com/track';

		/**
		 * Gets the tracking URL for a shipment.
		 *
		 * CONTRACT: the returned value is an ABSOLUTE URL and always carries the scheme
		 * and host. Every caller embeds this value verbatim in customer-facing email and
		 * in the REST response for the order; neither prefixes it. Returning a relative
		 * path from here renders as a broken link in every already-sent email template
		 * and in any integration that stored the value.
		 *
		 * @since 1.0.0
		 * @param string $tracking_number The carrier tracking number.
		 * @return string Absolute tracking URL.
		 */
		public static function get_tracking_url( $tracking_number ) {
			return self::TRACKING_BASE_URL . '/' . rawurlencode( $tracking_number );
		}
	}

endif;
