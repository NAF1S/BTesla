-- ---------------------------------------------------------------------------
-- The fare rounding unit: a charged fare is a whole number of taka.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Until now a fare was an exact decimal at the policy's `rounding_scale` -- a
-- perfectly reproducible number like `130.63`. That is the right way to *compute*
-- a price and the wrong way to *charge* one: nobody hands over sixty-three
-- poisha. This migration adds one more step, applied once, at the very end of
-- each calculation:
--
--     finalFare = round(GREATEST(minimumFare, subtotal + adjustment) / unit) × unit
--
-- with `unit` the policy's `fare_rounding_unit` (10 by default). The result is a
-- whole number of taka, and the same rule applies to a solo quote and to every
-- passenger's share of a pooled one.
--
-- ---------------------------------------------------------------------------
-- WHERE THE ROUNDING HAPPENS, AND WHERE IT DOES NOT
-- ---------------------------------------------------------------------------
-- Only the *charged* fare is rounded to the unit. The components that explain it
-- -- the base fare, the per-edge distance charges, the time fare, the traffic
-- adjustment, and on the pooled side the leg costs and leg shares -- keep the
-- policy's `rounding_scale`, because they are arithmetic rather than price.
--
-- That choice is what keeps the audit trail intact. The per-leg invariant that
-- makes a shared fare trustworthy -- *the shares of one leg add up to exactly
-- that leg's cost* -- is a statement about components, and it is untouched here.
-- `passenger_fare_leg_shares_sum_is_exact` still holds, and still means what it
-- meant.
--
-- Rounding the components to the unit instead would have been far simpler and
-- would have destroyed the breakdown: a 2214 m edge charged `59.78` would become
-- `60`, three of them would lose a taka apiece in a direction that depends on how
-- the route happened to be split into edges, and the stored per-edge audit trail
-- would no longer re-derive the stored total.
--
-- ---------------------------------------------------------------------------
-- THE DIFFERENCE IS RECORDED, NOT HIDDEN
-- ---------------------------------------------------------------------------
-- Rounding is money that is either given away or added, so it is written down:
-- `fare_rounding_adjustment = final_fare - (the fare before rounding)`. It is
-- **signed**, unlike the two cap reductions beside it, because rounding goes
-- whichever way is nearer -- `130.63` rounds down (adjustment `-0.63`) and
-- `126.00` rounds up (`+4.00`). Its magnitude is therefore at most half a unit.
--
-- Two identities replace the one they extend, and both are exact:
--
--   solo   : final_fare = GREATEST(minimum_fare, subtotal + adjustment)
--                        + fare_rounding_adjustment
--   pooled : final_fare + solo_cap_reduction + no_increase_reduction
--                        = GREATEST(minimum_fare, uncapped_pooled_fare)
--                        + fare_rounding_adjustment
--
-- ---------------------------------------------------------------------------
-- WHY THE UNIT IS ON THE POLICY, AND WHY THE MINIMUM FARE MUST DIVIDE BY IT
-- ---------------------------------------------------------------------------
-- A rounding unit is configuration, exactly like a rate: the schema's rule is
-- that no amount may come from anywhere else. It is a whole number of taka, so
-- a charged fare is always a whole number, which is what lets every serializer
-- present one with no decimals at all.
--
-- `minimum_fare` is required to be a whole number of units, and that is not
-- decoration. It is the proof that rounding can never undercut the floor: if the
-- fare before rounding is at least the minimum, and the minimum is itself a whole
-- number of units, then the nearest multiple of the unit is at least the minimum.
-- Without the constraint, a minimum of `85` and a unit of `10` would let an `86`
-- fare round down to `80` and quietly break the promise the minimum fare makes.
--
-- ---------------------------------------------------------------------------
-- LEGACY ROWS: `fare_rounding_unit IS NULL`
-- ---------------------------------------------------------------------------
-- Quotes and pooled calculations written before this migration were never
-- unit-rounded, and their stored fares are not multiples of any unit. Rewriting
-- them is impossible -- `fare_quotes` refuses UPDATE by trigger, and so do the
-- pooled child tables -- and wrong, since a quote is evidence of a price that was
-- really offered.
--
-- So the new columns are nullable, and NULL means exactly "this fare predates the
-- rule". Their adjustment is `0`, the identities above hold unchanged, and the
-- divisibility check is skipped. Nothing the application writes can be NULL: the
-- policy's unit is NOT NULL and at least 1, so a quote created after this
-- migration always carries a unit.
--
-- Idempotent: this file is re-applied by `npm run db:migrate`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. fare_policies: the unit, whole, and dividing the minimum fare
-- ---------------------------------------------------------------------------
ALTER TABLE fare_policies
  ADD COLUMN IF NOT EXISTS fare_rounding_unit NUMERIC(12, 4) NOT NULL DEFAULT 10;

DO $$
BEGIN
  -- A fractional unit (0.5) would make a charged fare fractional again, and a
  -- zero one would divide by zero, so the unit is a positive whole number.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fare_policies_fare_rounding_unit_whole'
  ) THEN
    ALTER TABLE fare_policies
      ADD CONSTRAINT fare_policies_fare_rounding_unit_whole
      CHECK (fare_rounding_unit >= 1 AND fare_rounding_unit = round(fare_rounding_unit));
  END IF;

  -- See the header: this is what makes "rounding never undercuts the minimum
  -- fare" a fact about the data rather than a hope about the code.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fare_policies_minimum_fare_is_whole_units'
  ) THEN
    ALTER TABLE fare_policies
      ADD CONSTRAINT fare_policies_minimum_fare_is_whole_units
      CHECK (mod(minimum_fare, fare_rounding_unit) = 0);
  END IF;
END $$;

-- The unit is a calculation input like any other, so a policy that has been
-- quoted must keep producing the same answer forever. This replaces the trigger
-- written in 07-fare-pricing.sql, whose frozen-column list predates the unit.
CREATE OR REPLACE FUNCTION prevent_referenced_fare_policy_change() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fare_quotes q WHERE q.fare_policy_id = OLD.id) THEN
    IF (NEW.code, NEW.version, NEW.currency, NEW.base_fare, NEW.per_kilometer_rate,
        NEW.per_minute_rate, NEW.minimum_fare, NEW.normal_traffic_multiplier,
        NEW.rush_hour_multiplier, NEW.rounding_scale, NEW.fare_rounding_unit)
       IS DISTINCT FROM
       (OLD.code, OLD.version, OLD.currency, OLD.base_fare, OLD.per_kilometer_rate,
        OLD.per_minute_rate, OLD.minimum_fare, OLD.normal_traffic_multiplier,
        OLD.rush_hour_multiplier, OLD.rounding_scale, OLD.fare_rounding_unit)
    THEN
      RAISE EXCEPTION
        'fare policy % version % has been quoted: create a new version instead of editing it',
        OLD.code, OLD.version
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. fare_quotes: the unit used, and the adjustment it produced
--
-- `ADD COLUMN ... NOT NULL DEFAULT 0` fills the rows that already exist without
-- an UPDATE, which matters because the immutability trigger below refuses one.
-- ---------------------------------------------------------------------------
ALTER TABLE fare_quotes
  ADD COLUMN IF NOT EXISTS fare_rounding_unit NUMERIC(14, 6),
  ADD COLUMN IF NOT EXISTS fare_rounding_adjustment NUMERIC(14, 6) NOT NULL DEFAULT 0;

COMMENT ON COLUMN fare_quotes.fare_rounding_unit IS
  'The unit the charged fare was rounded to (a whole number of taka). NULL for a quote written before the rule existed.';
COMMENT ON COLUMN fare_quotes.fare_rounding_adjustment IS
  'final_fare minus the fare before rounding. Signed: negative when rounded down, positive when rounded up.';

-- Replace the identity with the one rounding extends. The two other statements
-- it used to make -- the subtotal identity and the minimum-fare flag -- are
-- unchanged and restated here, because a CHECK is replaced whole.
DO $$
BEGIN
  ALTER TABLE fare_quotes DROP CONSTRAINT IF EXISTS fare_quotes_total_consistent;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fare_quotes_fare_rounding_unit_positive'
  ) THEN
    ALTER TABLE fare_quotes
      ADD CONSTRAINT fare_quotes_fare_rounding_unit_positive
      CHECK (fare_rounding_unit IS NULL OR fare_rounding_unit >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fare_quotes_rounding_within_half_a_unit'
  ) THEN
    -- CASE rather than an OR: PostgreSQL does not guarantee that a boolean
    -- expression evaluates its right-hand side only when the left is false, and
    -- `mod(x, NULL)` would be evaluated to satisfy a CHECK. A CASE selects one
    -- branch and evaluates only that one, so the division really is skipped.
    ALTER TABLE fare_quotes
      ADD CONSTRAINT fare_quotes_rounding_within_half_a_unit
      CHECK (
        CASE
          WHEN fare_rounding_unit IS NULL THEN fare_rounding_adjustment = 0
          ELSE mod(final_fare, fare_rounding_unit) = 0
               AND abs(fare_rounding_adjustment) * 2 <= fare_rounding_unit
        END
      );
  END IF;

  ALTER TABLE fare_quotes
    ADD CONSTRAINT fare_quotes_total_consistent CHECK (
      final_fare = GREATEST(minimum_fare, pre_traffic_subtotal + traffic_adjustment)
                   + fare_rounding_adjustment
      AND minimum_fare_applied = (minimum_fare > pre_traffic_subtotal + traffic_adjustment)
    );
END $$;

-- ---------------------------------------------------------------------------
-- 3. pool_fare_calculations: the unit, and the adjustment across the pool
-- ---------------------------------------------------------------------------
ALTER TABLE pool_fare_calculations
  ADD COLUMN IF NOT EXISTS fare_rounding_unit NUMERIC(14, 6),
  ADD COLUMN IF NOT EXISTS total_fare_rounding_adjustment NUMERIC(14, 6) NOT NULL DEFAULT 0;

COMMENT ON COLUMN pool_fare_calculations.total_fare_rounding_adjustment IS
  'The sum of the per-passenger fare rounding adjustments: money the unit rounding added to or took off the pool.';

DO $$
BEGIN
  ALTER TABLE pool_fare_calculations DROP CONSTRAINT IF EXISTS pool_fare_calculations_totals_consistent;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pool_fare_calculations_fare_rounding_unit_positive'
  ) THEN
    ALTER TABLE pool_fare_calculations
      ADD CONSTRAINT pool_fare_calculations_fare_rounding_unit_positive
      CHECK (fare_rounding_unit IS NULL OR fare_rounding_unit >= 1);
  END IF;

  -- The third reduction: the passengers were asked for the base fares plus the
  -- legs, the minimum fare may have raised some of those, the two caps may have
  -- brought some back down -- and the unit rounding moved every one of them to a
  -- whole number of taka. All four are accounted for.
  ALTER TABLE pool_fare_calculations
    ADD CONSTRAINT pool_fare_calculations_totals_consistent CHECK (
      total_uncapped_passenger_fare = total_passenger_base_fare + total_variable_route_cost
      AND total_final_passenger_fare + total_solo_cap_reduction + total_no_increase_reduction
          = total_uncapped_passenger_fare + total_minimum_fare_uplift
            + total_fare_rounding_adjustment
    );
END $$;

-- ---------------------------------------------------------------------------
-- 4. passenger_fare_allocations: the same, per passenger
--
-- The unit is stored on the allocation as well as on the calculation, because a
-- CHECK cannot read another table -- and the divisibility of the fare this
-- passenger was charged is a fact the row has to be able to prove by itself.
-- ---------------------------------------------------------------------------
ALTER TABLE passenger_fare_allocations
  ADD COLUMN IF NOT EXISTS fare_rounding_unit NUMERIC(14, 6),
  ADD COLUMN IF NOT EXISTS fare_rounding_adjustment NUMERIC(14, 6) NOT NULL DEFAULT 0;

COMMENT ON COLUMN passenger_fare_allocations.fare_rounding_adjustment IS
  'final_fare minus this passenger''s fare before rounding. Signed, and at most half a unit.';

DO $$
BEGIN
  ALTER TABLE passenger_fare_allocations DROP CONSTRAINT IF EXISTS passenger_fare_allocations_caps_consistent;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'passenger_fare_allocations_rounding_unit_positive'
  ) THEN
    ALTER TABLE passenger_fare_allocations
      ADD CONSTRAINT passenger_fare_allocations_rounding_unit_positive
      CHECK (fare_rounding_unit IS NULL OR fare_rounding_unit >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'passenger_fare_allocations_rounding_within_half_a_unit'
  ) THEN
    ALTER TABLE passenger_fare_allocations
      ADD CONSTRAINT passenger_fare_allocations_rounding_within_half_a_unit
      CHECK (
        CASE
          WHEN fare_rounding_unit IS NULL THEN fare_rounding_adjustment = 0
          ELSE mod(final_fare, fare_rounding_unit) = 0
               AND abs(fare_rounding_adjustment) * 2 <= fare_rounding_unit
        END
      );
  END IF;

  -- The caps, the rounding, and nothing else, decide the final fare.
  ALTER TABLE passenger_fare_allocations
    ADD CONSTRAINT passenger_fare_allocations_caps_consistent CHECK (
      final_fare + solo_cap_reduction + no_increase_reduction
        = GREATEST(minimum_fare, uncapped_pooled_fare) + fare_rounding_adjustment
    );
END $$;

-- ---------------------------------------------------------------------------
-- 5. The caps are whole numbers of the unit too
--
-- This is the constraint that keeps rounding from *breaking* a passenger
-- protection, and it is worth spelling out why it is enough.
--
-- Both caps are fares: `accepted_solo_fare` is the quote the passenger accepted,
-- and `previous_pooled_fare_cap` is what they were charged by the previous pool
-- version. Every fare this application writes is a whole number of units, so in
-- practice both already divide. Forcing it here turns that from a habit into a
-- fact -- and given it, rounding cannot carry a fare past either cap:
--
--   if the cap is a multiple of `u`, and the fare before rounding is at most the
--   cap, then the nearest multiple of `u` is at most the cap. (If it were more,
--   it would be at least `cap + u`, and the fare would have to be at least
--   `cap + u/2`, which is more than the cap.)
--
-- Without this, a cap of 95 with a unit of 10 would round a 94 fare up to 100 --
-- above what the passenger was promised. `passenger_fare_allocations_solo_cap_holds`
-- would refuse the row, so the failure would be loud rather than silent, but a
-- calculation that cannot be written at all is not a better outcome than one that
-- cannot go wrong.
--
-- Legacy rows are skipped, for the same reason their adjustment is zero: their
-- unit is NULL and no rounding happened to them.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'passenger_fare_allocations_caps_are_whole_units'
  ) THEN
    ALTER TABLE passenger_fare_allocations
      ADD CONSTRAINT passenger_fare_allocations_caps_are_whole_units CHECK (
        CASE
          WHEN fare_rounding_unit IS NULL THEN true
          ELSE mod(accepted_solo_fare, fare_rounding_unit) = 0
               AND (previous_pooled_fare_cap IS NULL
                    OR mod(previous_pooled_fare_cap, fare_rounding_unit) = 0)
        END
      );
  END IF;
END $$;
