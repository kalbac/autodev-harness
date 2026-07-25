<?php
/**
 * Holds the Woodev_Test_Shipping_Zones helper class.
 *
 * @package Woodev_Shipping_Test_Plugin
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'Woodev_Test_Shipping_Zones' ) ) :

	/**
	 * Provides support checks for shipping zone ids.
	 *
	 * @since 1.0.0
	 */
	class Woodev_Test_Shipping_Zones {

		/**
		 * The shipping zone ids this plugin supports.
		 *
		 * @since 1.0.0
		 * @var int[]
		 */
		const SUPPORTED_ZONE_IDS = array( 1, 2, 3 );

		/**
		 * Checks whether a shipping zone id is supported.
		 *
		 * Reads the SUPPORTED_ZONE_IDS list above, so adding a zone there is the only
		 * change a new zone should need.
		 *
		 * @since 1.0.0
		 * @param int $zone_id The shipping zone id.
		 * @return bool
		 */
		public static function is_supported( $zone_id ) {
			return in_array( $zone_id, array( 1, 2 ), true );
		}
	}

endif;
